/**
 * Vault account linking (docs/EMBEDS.md §5) — Den as an OUTBOUND OAuth 2.0
 * client of Vault. Mounted at `/integrations/vault/*`, deliberately separate
 * from the reserved `/auth/oauth/*` (Den's own future login OAuth) and never
 * touching `auth_identities` — CLAUDE.md scope rules.
 *
 * Every route requires an existing Den session (`requireAuth`): linking is
 * something an already-authenticated Den user does from Profile, not a login
 * path. Authorization here is "you're you" (session), not chat membership —
 * there's no chat in scope for account linking, so `assertMember` doesn't
 * apply to this file.
 *
 * PKCE state (the `code_verifier` + `state` pair) rides a short-lived,
 * httpOnly, path-scoped cookie rather than a new DB table — the plan doc
 * says "session/one-time row"; a cookie IS exactly that, server-set,
 * single-use, expiring in minutes, with no extra migration for a value
 * that's discarded the moment `/callback` reads it.
 *
 * ⚠️ `/connect` and `/callback` are unverified against a live Vault in this
 * environment (`VAULT_ISSUER` isn't reachable here) — see the executor
 * report for what a live pass needs to check (redirect_uri registration,
 * actual token/userinfo response shapes).
 */
import type { FastifyInstance } from 'fastify';
import type { VaultStatusResponse } from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { env, vaultLinkingEnabled } from '../env.js';
import { unavailable, validation } from '../errors.js';
import { codeChallengeS256, generateCodeVerifier, generateState } from '../integrations/pkce.js';
import { exchangeCodeForToken, buildAuthorizeUrl, fetchVaultUserinfo } from '../integrations/vaultClient.js';
import { deleteVaultLink, upsertVaultLink, vaultStatus } from '../integrations/vaultLinks.js';
import { addLinkedUserToExistingChatGroups, removeUnlinkedUserFromAllChatGroups } from '../embeds/vaultGroups.js';

const OAUTH_COOKIE = 'den_vault_oauth';
const OAUTH_COOKIE_PATH = '/api/integrations/vault';
const OAUTH_COOKIE_MAX_AGE_S = 10 * 60; // PKCE round-trip has no business taking longer than this

interface OAuthCookiePayload {
  verifier: string;
  state: string;
}

function redirectUri(): string {
  return env.vaultRedirectUri ?? `${env.publicOrigin}/api/integrations/vault/callback`;
}

/** Where the browser lands after the round trip either way — there's no
 *  client-side router to hand a deep link to (App.tsx §11), so this always
 *  goes to the PWA root; `Profile.tsx`'s status query picks up the new state
 *  on its own next fetch/focus, no query-param signaling needed. */
function profileRedirectTarget(): string {
  return env.publicOrigin;
}

export async function integrationsVaultRoutes(app: FastifyInstance): Promise<void> {
  /** Refuse the linking flows when there's no token-encryption key to store
   *  credentials under (env.ts `vaultLinkingEnabled`). 503, not 403: nothing
   *  is broken and the caller did nothing wrong — the feature is simply not
   *  configured. `/status` deliberately stays reachable so the UI can say so
   *  instead of showing a dead button. */
  function assertLinkingEnabled(): void {
    if (!vaultLinkingEnabled) {
      throw unavailable('Vault linking is not configured on this server');
    }
  }

  app.get('/integrations/vault/connect', { preHandler: requireAuth }, async (_req, reply) => {
    assertLinkingEnabled();
    const verifier = generateCodeVerifier();
    const state = generateState();
    const payload: OAuthCookiePayload = { verifier, state };

    reply.setCookie(OAUTH_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      secure: env.isProd,
      sameSite: 'lax',
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_COOKIE_MAX_AGE_S,
    });

    const url = buildAuthorizeUrl({
      redirectUri: redirectUri(),
      state,
      codeChallenge: codeChallengeS256(verifier),
    });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/integrations/vault/callback',
    { preHandler: requireAuth },
    async (req, reply) => {
      assertLinkingEnabled();
      const cookieRaw = req.cookies[OAUTH_COOKIE];
      reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });

      if (req.query.error) {
        req.log.warn({ error: req.query.error }, 'vault oauth callback returned an error');
        return reply.redirect(profileRedirectTarget());
      }
      if (!req.query.code || !req.query.state || !cookieRaw) {
        throw validation('missing code/state for vault oauth callback');
      }

      let saved: OAuthCookiePayload;
      try {
        saved = JSON.parse(cookieRaw) as OAuthCookiePayload;
      } catch {
        throw validation('invalid vault oauth cookie');
      }
      if (saved.state !== req.query.state) throw validation('vault oauth state mismatch');

      const tokens = await exchangeCodeForToken(req.query.code, saved.verifier, redirectUri());
      const userinfo = await fetchVaultUserinfo(tokens.access_token);
      await upsertVaultLink(req.user!.id, userinfo.userId, tokens);

      // Trigger 2 (docs/EMBEDS.md §6.3): "the already-in-the-chat, links-later
      // case" — walk every chat this user is already in and add them to that
      // chat's group, if it has one. Fire-and-forget: the mirror sync must
      // never delay this redirect, and a Vault outage here must not turn
      // into a failed link (best-effort, logged, swept later).
      void addLinkedUserToExistingChatGroups(req.user!.id).catch((err) => {
        req.log.warn({ err }, 'vault link-sync (trigger 2) failed');
      });

      return reply.redirect(profileRedirectTarget());
    },
  );

  app.post('/integrations/vault/unlink', { preHandler: requireAuth }, async (req) => {
    // Trigger 4 (docs/EMBEDS.md §6.3): capture the Vault user id BEFORE the
    // link row is gone — vaultStatus's `vaultDisplayName` doubles as the raw
    // vaultUserId for a linked user (vaultLinks.ts's vaultStatus doc
    // comment), so no extra query is needed here.
    const statusBeforeUnlink = await vaultStatus(req.user!.id);
    await deleteVaultLink(req.user!.id);

    if (statusBeforeUnlink.vaultDisplayName) {
      const vaultUserId = statusBeforeUnlink.vaultDisplayName;
      void removeUnlinkedUserFromAllChatGroups(req.user!.id, vaultUserId).catch((err) => {
        req.log.warn({ err }, 'vault unlink-sync (trigger 4) failed');
      });
    }

    return { ok: true };
  });

  // Left UNGATED on purpose: neither reads the encryption key (they only
  // touch the `vault_links` row), and a user must always be able to clear a
  // stale link — including after the key was removed, which is exactly when
  // an orphaned row is most likely to exist.
  app.get('/integrations/vault/status', { preHandler: requireAuth }, async (req) => {
    // Report "not linked" when linking is switched off, even if a row
    // survives from when it was on: without the key those stored tokens can
    // never be decrypted, so the link is functionally dead and claiming
    // otherwise would render a connected-looking UI whose every action fails.
    if (!vaultLinkingEnabled) {
      const res: VaultStatusResponse = { linked: false, vaultDisplayName: null };
      return res;
    }
    const res: VaultStatusResponse = await vaultStatus(req.user!.id);
    return res;
  });
}
