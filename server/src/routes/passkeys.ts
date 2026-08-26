/**
 * Passkey (WebAuthn) routes — docs/PASSKEYS.md §6.
 *
 * These are the exact paths reserved since migration 001 (`docs/archive/
 * BACKBONE.md` §6) and they honour the assumptions stated in routes/auth.ts:
 * invites AUTHORIZE and providers AUTHENTICATE, so a passkey can never create
 * an account — only prove one. Registration therefore requires an existing
 * session; there is no passkey sign-up path.
 *
 * ⚠️ **`checkLock` must never appear in this file** (docs/PASSKEYS.md §7).
 * The per-account login throttle exists to bound password guessing. A passkey
 * assertion is a cryptographic proof — it cannot be guessed, so throttling it
 * protects nothing, and refusing it during a password lock would rebuild the
 * lockout DoS behind a different door. The whole reason passkeys make that
 * lock tolerable is that a locked-out user can still get in this way. A
 * successful assertion instead CLEARS the password failure counter, because
 * proving who you are should reset it however you proved it.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  PasskeyLimits,
  type AuthResponse,
  type PasskeyCredential,
  type PasskeyListResponse,
  type PasskeyLoginVerifyRequest,
  type PasskeyRegisterVerifyRequest,
  type PasskeyRenameRequest,
} from '@den/shared';
import { db } from '../db/index.js';
import { users, webauthnCredentials } from '../db/schema.js';
import { createSession, requireAuth } from '../auth/session.js';
import { clearFailures } from '../auth/throttle.js';
import {
  RP_NAME,
  assertNotLastLoginMethod,
  defaultLabel,
  expectedOrigins,
  loginMethodsFor,
  newUserHandle,
  passkeyFailed,
  rpID,
  setChallenge,
  takeChallenge,
} from '../auth/webauthn.js';
import { toPublicUser } from '../mappers.js';
import { notFound, validation } from '../errors.js';

/** Same coarse flood backstop the credential routes use (docs/AUTH_HARDENING.md
 *  §2.3). These are unauthed endpoints that do real work; nothing more is
 *  needed, because there is no secret here to guess. */
const passkeyLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

function checkLabel(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const label = s || fallback;
  if (label.length > PasskeyLimits.labelMax) {
    throw validation(`label too long (max ${PasskeyLimits.labelMax})`);
  }
  return label;
}

function toCredentialDto(row: {
  id: string;
  deviceLabel: string | null;
  transports: string[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}): PasskeyCredential {
  return {
    id: row.id,
    label: row.deviceLabel ?? 'Passkey',
    transports: row.transports ?? [],
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  // ── register: options ───────────────────────────────────────────────────
  app.post('/auth/passkey/register/options', { preHandler: requireAuth }, async (req, reply) => {
    const me = req.user!;

    const existing = await db
      .select({ id: webauthnCredentials.id, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, me.id));

    if (existing.length >= PasskeyLimits.maxCredentials) {
      throw validation(`you already have ${PasskeyLimits.maxCredentials} passkeys`);
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpID(),
      // ⚠️ An opaque handle, never the username or the row id — this value is
      // written into the credential on the device and surfaces in passkey
      // managers (auth/webauthn.ts:newUserHandle).
      userID: newUserHandle(),
      userName: me.username,
      userDisplayName: me.displayName,
      // Nothing about which hardware made the key is useful to a friend
      // circle, and asking for it triggers scarier OS prompts.
      attestationType: 'none',
      // Already-registered credentials, so the authenticator says "you already
      // have one of these" instead of silently making a duplicate.
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: (c.transports ?? []) as never,
      })),
      authenticatorSelection: {
        // Discoverable, so login needs no username typed (docs/PASSKEYS.md §6).
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });

    setChallenge(reply, options.challenge, me.id);
    return options;
  });

  // ── register: verify ────────────────────────────────────────────────────
  app.post<{ Body: PasskeyRegisterVerifyRequest }>(
    '/auth/passkey/register/verify',
    { preHandler: requireAuth },
    async (req, reply) => {
      const me = req.user!;
      const { challenge, userId } = takeChallenge(req, reply);

      // The challenge was minted for a specific session user; completing it as
      // anyone else is a bug or an attack. Either way, refuse.
      if (userId !== me.id.toString()) throw passkeyFailed();

      // `unknown` first: the DTO is deliberately an opaque bag (shared/api.ts)
      // so we never hand-maintain a mirror of the WebAuthn spec. The library
      // is what actually validates the shape, a line below.
      const response = req.body?.response as unknown as RegistrationResponseJSON | undefined;
      if (!response) throw passkeyFailed();

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins(),
          expectedRPID: rpID(),
        });
      } catch {
        // Library throws on malformed input; that is a failed ceremony, not a 500.
        throw passkeyFailed();
      }
      if (!verification.verified) throw passkeyFailed();

      const { credential } = verification.registrationInfo;
      const label = checkLabel(req.body?.label, defaultLabel(req.headers['user-agent']));

      try {
        await db.insert(webauthnCredentials).values({
          id: credential.id,
          userId: me.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: BigInt(credential.counter),
          transports: credential.transports ? [...credential.transports] : null,
          deviceLabel: label,
        });
      } catch (e) {
        // Same credential registered twice — the excludeCredentials hint above
        // usually prevents it, but a race or an ignoring authenticator can get
        // here. Not an error worth surfacing: the desired state already holds.
        if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
          return reply.status(200).send({ ok: true });
        }
        throw e;
      }

      req.log.info({ userId: me.id.toString(), credentialId: credential.id }, 'passkey registered');
      return reply.status(201).send({ ok: true });
    },
  );

  // ── login: options ──────────────────────────────────────────────────────
  //
  // No username, no allowCredentials — discoverable credentials mean the
  // authenticator picks, and asking for a username here would both defeat the
  // one-tap flow and hand out an account-existence oracle.
  app.post('/auth/passkey/login/options', passkeyLimit, async (_req, reply) => {
    const options = await generateAuthenticationOptions({
      rpID: rpID(),
      userVerification: 'preferred',
    });
    setChallenge(reply, options.challenge, null);
    return options;
  });

  // ── login: verify ───────────────────────────────────────────────────────
  app.post<{ Body: PasskeyLoginVerifyRequest }>(
    '/auth/passkey/login/verify',
    passkeyLimit,
    async (req, reply) => {
      const { challenge } = takeChallenge(req, reply);
      const response = req.body?.response as unknown as AuthenticationResponseJSON | undefined;
      if (!response?.id) throw passkeyFailed();

      const rows = await db
        .select({
          id: webauthnCredentials.id,
          userId: webauthnCredentials.userId,
          publicKey: webauthnCredentials.publicKey,
          signCount: webauthnCredentials.signCount,
          transports: webauthnCredentials.transports,
          username: users.username,
          displayName: users.displayName,
          avatarKey: users.avatarKey,
        })
        .from(webauthnCredentials)
        .innerJoin(users, eq(users.id, webauthnCredentials.userId))
        .where(eq(webauthnCredentials.id, response.id))
        .limit(1);

      const cred = rows[0];
      // Unknown credential reports exactly like a bad signature — see
      // auth/webauthn.ts:passkeyFailed for why these are not distinguished.
      if (!cred) throw passkeyFailed();

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins(),
          expectedRPID: rpID(),
          credential: {
            id: cred.id,
            publicKey: new Uint8Array(cred.publicKey),
            counter: Number(cred.signCount),
            transports: (cred.transports ?? []) as never,
          },
        });
      } catch {
        throw passkeyFailed();
      }
      if (!verification.verified) throw passkeyFailed();

      // ⚠️ Signature-counter check (docs/PASSKEYS.md §5). Most platform
      // authenticators (Apple, Google) always report 0 — that is normal and
      // must NOT be read as an attack. Only when a counter is actually in use
      // does a non-increasing value mean a cloned credential.
      const stored = Number(cred.signCount);
      const presented = verification.authenticationInfo.newCounter;
      if (stored > 0 || presented > 0) {
        if (presented <= stored) {
          req.log.warn(
            { credentialId: cred.id, stored, presented },
            'passkey sign-count did not advance — possible cloned credential',
          );
          throw passkeyFailed();
        }
      }

      await db
        .update(webauthnCredentials)
        .set({ signCount: BigInt(presented), lastUsedAt: new Date() })
        .where(eq(webauthnCredentials.id, cred.id));

      // Proving identity resets the password failure counter, exactly as a
      // successful password login does (docs/PASSKEYS.md §7 rule 2). This is
      // what lets a passkey lift a lock an attacker caused.
      await clearFailures(cred.username);

      await createSession(reply, cred.userId, req.headers['user-agent']);
      req.log.info({ userId: cred.userId.toString(), credentialId: cred.id }, 'passkey login');

      const res: AuthResponse = toPublicUser({
        id: cred.userId,
        username: cred.username,
        displayName: cred.displayName,
        avatarKey: cred.avatarKey,
      });
      return res;
    },
  );

  // ── list ────────────────────────────────────────────────────────────────
  app.get('/auth/passkey/credentials', { preHandler: requireAuth }, async (req) => {
    const me = req.user!;
    const [rows, methods] = await Promise.all([
      db
        .select({
          id: webauthnCredentials.id,
          deviceLabel: webauthnCredentials.deviceLabel,
          transports: webauthnCredentials.transports,
          createdAt: webauthnCredentials.createdAt,
          lastUsedAt: webauthnCredentials.lastUsedAt,
        })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, me.id))
        .orderBy(desc(webauthnCredentials.createdAt)),
      loginMethodsFor(me.id),
    ]);
    const res: PasskeyListResponse = {
      credentials: rows.map(toCredentialDto),
      hasPassword: methods.hasPassword,
    };
    return res;
  });

  // ── rename ──────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: PasskeyRenameRequest }>(
    '/auth/passkey/credentials/:id',
    { preHandler: requireAuth },
    async (req) => {
      const me = req.user!;
      const label = checkLabel(req.body?.label, '');
      if (!label) throw validation('label required');

      // ⚠️ The user_id in the WHERE is the authorization — a credential id is
      // guessable-ish and belongs to exactly one account. Never look up by id
      // alone and check ownership afterwards.
      const updated = await db
        .update(webauthnCredentials)
        .set({ deviceLabel: label })
        .where(and(eq(webauthnCredentials.id, req.params.id), eq(webauthnCredentials.userId, me.id)))
        .returning({ id: webauthnCredentials.id });
      if (updated.length === 0) throw notFound('passkey not found');
      return { ok: true };
    },
  );

  // ── remove ──────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/auth/passkey/credentials/:id',
    { preHandler: requireAuth },
    async (req) => {
      const me = req.user!;

      const owned = await db
        .select({ id: webauthnCredentials.id })
        .from(webauthnCredentials)
        .where(and(eq(webauthnCredentials.id, req.params.id), eq(webauthnCredentials.userId, me.id)))
        .limit(1);
      if (owned.length === 0) throw notFound('passkey not found');

      // Never leave an account with no way in (auth/webauthn.ts).
      await assertNotLastLoginMethod(me.id);

      await db
        .delete(webauthnCredentials)
        .where(and(eq(webauthnCredentials.id, req.params.id), eq(webauthnCredentials.userId, me.id)));
      req.log.info({ userId: me.id.toString(), credentialId: req.params.id }, 'passkey removed');
      return { ok: true };
    },
  );
}
