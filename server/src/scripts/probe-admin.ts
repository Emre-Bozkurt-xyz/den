/**
 * Owner console check (docs/ADMIN_CONSOLE.md §10).
 *
 * The first section is the one that matters and it is not a normal test: it
 * asserts an **invariant about what the console can never show**. Hard
 * invariant 1 makes chat membership the whole privacy model, and this is the
 * first authorization concept that isn't membership — so the boundary is
 * verified mechanically rather than trusted to reviewers as the console grows.
 *
 * ⚠️ Dev stack only. Grants and revokes owner on a throwaway account.
 *
 *   PROBE_INVITES=<code1>,<code2> npx tsx server/src/scripts/probe-admin.ts http://localhost:3001
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, messages, users } from '../db/schema.js';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

class Session {
  private cookies = new Map<string, string>();
  async call(
    path: string,
    init: { method?: string; body?: unknown } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe: see probe-passkey.ts
  ): Promise<{ status: number; body: any; code: string | null; raw: string }> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, idx), pair!.slice(idx + 1));
    }
    const raw = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    return { status: res.status, body, code: body?.error?.code ?? null, raw };
  }
}

/** Every read-only console route, so coverage can't silently drift. */
const ADMIN_ROUTES = [
  '/api/admin/events',
  '/api/admin/locks',
  '/api/admin/users',
  '/api/admin/invites',
  '/api/admin/push-health',
];

const rnd = () => randomBytes(5).toString('hex');

async function main(): Promise<void> {
  console.log(`\nProbing ${base}\n`);
  const health = await fetch(`${base}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${base}/health did not answer OK — is the stack up?`);
    process.exitCode = 1;
    return;
  }

  const codes = (process.env.PROBE_INVITES ?? '').split(',').filter(Boolean);
  if (codes.length < 2) {
    console.error('✗ set PROBE_INVITES=<code1>,<code2>');
    process.exitCode = 1;
    return;
  }

  const ownerName = `adm-owner-${rnd()}`;
  const plainName = `adm-plain-${rnd()}`;
  const password = 'probe-password-1234';
  const owner = new Session();
  const plain = new Session();

  for (const [s, name, code] of [
    [owner, ownerName, codes[0]!],
    [plain, plainName, codes[1]!],
  ] as const) {
    const r = await s.call('/api/auth/register', {
      body: { username: name, password, displayName: name, inviteCode: code },
    });
    if (r.status !== 201) {
      console.error(`✗ could not register ${name}: ${r.status} ${r.code}`);
      process.exitCode = 1;
      return;
    }
  }

  // ── 1. locked down before anyone is an owner ────────────────────────────
  console.log('1. a non-owner is refused everywhere');
  for (const route of ADMIN_ROUTES) {
    const r = await plain.call(route);
    check(`${route} → 403`, r.status === 403 && r.code === 'forbidden', `${r.status} ${r.code}`);
  }
  const anon = await new Session().call('/api/admin/users');
  check('unauthenticated → 401', anon.status === 401, `${anon.status} ${anon.code}`);

  const meBefore = await owner.call('/api/me');
  check('me.isOwner is false before the grant', meBefore.body?.isOwner === false, String(meBefore.body?.isOwner));

  // ── 2. grant from the shell, the ONLY way ───────────────────────────────
  console.log('\n2. grant owner (as the CLI does — direct DB write, no route)');
  await db.update(users).set({ isOwner: true }).where(eq(users.username, ownerName));
  const meAfter = await owner.call('/api/me');
  check('me.isOwner is true after the grant', meAfter.body?.isOwner === true, String(meAfter.body?.isOwner));

  const stillPlain = await plain.call('/api/admin/users');
  check('the OTHER user is still refused', stillPlain.status === 403, `${stillPlain.status}`);

  // ── 3. the owner can read ───────────────────────────────────────────────
  console.log('\n3. the owner can read every panel');
  for (const route of ADMIN_ROUTES) {
    const r = await owner.call(route);
    check(`${route} → 200`, r.status === 200, `${r.status} ${r.code ?? ''}`);
  }

  // ── 4. THE BOUNDARY (docs/ADMIN_CONSOLE.md §2) ──────────────────────────
  //
  // The console must never expose message content, media, or who talks to
  // whom. Verified against real data: the two probe accounts exchange a
  // message with a distinctive body, then every admin response is scanned for
  // it. This is the check that keeps the privacy model honest as panels are
  // added — a future join to `messages` would fail here rather than in review.
  console.log('\n4. the owner is an OPERATOR, not a READER');
  // Real data to leak. Messages are sent over WS, so the rows are written
  // directly — the point is that a message EXISTS for the console to expose,
  // not how it got there.
  const secret = 'SEKRIT-' + randomBytes(8).toString('hex');
  const ownerId = BigInt(meAfter.body.id as string);
  const plainMe = await plain.call('/api/me');
  const plainId = BigInt(plainMe.body.id as string);
  const lo = ownerId < plainId ? ownerId : plainId;
  const hi = ownerId < plainId ? plainId : ownerId;
  const inserted = await db
    .insert(chats)
    .values({ isGroup: false, dmKey: lo.toString() + ':' + hi.toString(), createdBy: plainId })
    .returning({ id: chats.id });
  const chatId = inserted[0]!.id;
  await db.insert(chatMembers).values([
    { chatId, userId: plainId },
    { chatId, userId: ownerId },
  ]);
  await db.insert(messages).values({ chatId, senderId: plainId, kind: 'text', body: secret });
  console.log('   seeded a chat + message containing ' + secret);
  const forbiddenKeys = ['body', 'messages', 'media', 'caption', 'chatId', 'chats', 'members', 'preview'];
  for (const route of ADMIN_ROUTES) {
    const r = await owner.call(route);
    const leaked = forbiddenKeys.filter((k) => new RegExp(`"${k}"\\s*:`).test(r.raw));
    check(
      `${route} carries no chat-shaped field`,
      leaked.length === 0,
      leaked.length ? `leaked: ${leaked.join(', ')}` : '',
    );
    check(`${route} does not echo message text`, !r.raw.includes(secret));
  }

  // ── 5. sessions never expose the bearer token ───────────────────────────
  //
  // `sessions.id` IS the cookie value. An admin page that listed them would
  // hand over every account it displayed.
  console.log('\n5. session listing hands out no usable token');
  const uid = meAfter.body?.id as string;
  const sess = await owner.call(`/api/admin/users/${uid}/sessions`);
  check('sessions listed', sess.status === 200 && Array.isArray(sess.body?.sessions), `${sess.status}`);
  const ids: string[] = (sess.body?.sessions ?? []).map((s: { id: string }) => s.id);
  check('at least one session present', ids.length > 0, `${ids.length}`);
  check(
    'no listed id is a usable 43-char session token',
    ids.every((i) => i.length <= 24),
    ids.join(','),
  );
  if (ids[0]) {
    // The real test of §5: try to USE a listed id as a credential.
    const r = await fetch(`${base}/api/me`, { headers: { cookie: `den_session=${ids[0]}` } });
    check('a listed id cannot be used as a session cookie', r.status === 401, String(r.status));
  }
  check(
    'the current session is flagged',
    (sess.body?.sessions ?? []).some((s: { current: boolean }) => s.current),
  );

  // ── 6. the feed recorded what happened ──────────────────────────────────
  console.log('\n6. the feed has real history');
  const feed = await owner.call('/api/admin/events');
  const kinds: string[] = (feed.body?.events ?? []).map((e: { kind: string }) => e.kind);
  check('invite.claimed was recorded', kinds.includes('invite.claimed'), kinds.join(', ') || 'empty');

  // Lock the plain account, then confirm the event landed.
  for (let i = 0; i < 12; i++) {
    const r = await new Session().call('/api/auth/login', {
      body: { username: plainName, password: 'wrong-password-here' },
    });
    if (r.status === 423) break;
  }
  const feed2 = await owner.call('/api/admin/events');
  const kinds2: string[] = (feed2.body?.events ?? []).map((e: { kind: string }) => e.kind);
  check('login.locked was recorded', kinds2.includes('login.locked'), kinds2.slice(0, 4).join(', '));

  const locks = await owner.call('/api/admin/locks');
  const locked = (locks.body?.locks ?? []).find((l: { username: string }) => l.username === plainName);
  check('the lock shows in the locks panel', locked?.locked === true, JSON.stringify(locked ?? null));

  // ── 7. the re-auth gate (docs/ADMIN_CONSOLE.md §6) ──────────────────────
  //
  // A valid session is enough to READ. It is deliberately not enough to do
  // anything irreversible — that is the whole point of the gate, so it is
  // checked before any of the destructive actions are exercised.
  console.log('\n7. destructive actions require fresh proof of identity');
  const plainIdStr = plainId.toString();

  const noFresh = await owner.call(`/api/admin/users/${plainIdStr}/disable`, { method: 'POST' });
  check('disable without re-auth → reauth_required', noFresh.status === 401 && noFresh.code === 'reauth_required', `${noFresh.status} ${noFresh.code}`);
  const noFresh2 = await owner.call(`/api/admin/users/${plainIdStr}/sessions`, { method: 'DELETE' });
  check('revoke-sessions without re-auth → reauth_required', noFresh2.status === 401 && noFresh2.code === 'reauth_required', `${noFresh2.status} ${noFresh2.code}`);

  // Low-harm actions deliberately do NOT demand it — a prompt on every unlock
  // trains the owner to click through, which is how a control stops working.
  const unlock = await owner.call(`/api/admin/locks/${plainName}/clear`, { method: 'POST' });
  check('clearing a lock needs no re-auth', unlock.status === 200, `${unlock.status} ${unlock.code ?? ''}`);
  const mint = await owner.call('/api/admin/invites', { body: { count: 2 } });
  check('minting invites needs no re-auth', mint.status === 200 && mint.body?.codes?.length === 2, `${mint.status}`);

  const badPw = await owner.call('/api/admin/reauth/password', { body: { password: 'not-my-password' } });
  check('re-auth with a wrong password is refused', badPw.status === 401 && badPw.code === 'invalid_credentials', `${badPw.status} ${badPw.code}`);

  const goodPw = await owner.call('/api/admin/reauth/password', { body: { password } });
  check('re-auth with the right password succeeds', goodPw.status === 200, `${goodPw.status} ${goodPw.code ?? ''}`);

  // ⚠️ A marker minted by the owner must not authorize the OTHER account, even
  // though the cookie is validly signed. The subject check is what stops that.
  const stolen = await plain.call(`/api/admin/users/${plainIdStr}/disable`, { method: 'POST' });
  check("another user cannot ride the owner's re-auth", stolen.status === 403, `${stolen.status} ${stolen.code}`);

  // ── 8. the actions themselves ───────────────────────────────────────────
  console.log('\n8. actions, now that identity is fresh');

  const revoked = await owner.call(`/api/admin/users/${plainIdStr}/sessions`, { method: 'DELETE' });
  check('sessions revoked', revoked.status === 200, `${revoked.status} ${revoked.code ?? ''}`);
  const deadSession = await plain.call('/api/me');
  check("the other user's session is dead", deadSession.status === 401, `${deadSession.status}`);

  const ownerStillIn = await owner.call('/api/me');
  check('the owner is still signed in', ownerStillIn.status === 200, `${ownerStillIn.status}`);

  const revokeInvite = await owner.call(`/api/admin/invites/${mint.body.codes[0]}`, { method: 'DELETE' });
  check('an unused invite can be revoked', revokeInvite.status === 200, `${revokeInvite.status} ${revokeInvite.code ?? ''}`);
  const revokeAgain = await owner.call(`/api/admin/invites/${mint.body.codes[0]}`, { method: 'DELETE' });
  check('revoking it twice is a 404, not a silent success', revokeAgain.status === 404, `${revokeAgain.status}`);

  // A revoked code must not be claimable.
  const claimRevoked = await new Session().call('/api/auth/register', {
    body: { username: `rev-${rnd()}`, password, displayName: 'x', inviteCode: mint.body.codes[0] },
  });
  check('a revoked invite cannot be claimed', claimRevoked.status === 400 && claimRevoked.code === 'invalid_invite', `${claimRevoked.status} ${claimRevoked.code}`);

  // ── 9. disable (docs/ADMIN_CONSOLE.md §7) ───────────────────────────────
  console.log('\n9. disabling an account');
  const selfDisable = await owner.call(`/api/admin/users/${meAfter.body.id}/disable`, { method: 'POST' });
  check('the owner cannot disable themselves', selfDisable.status === 403, `${selfDisable.status} ${selfDisable.code}`);

  const disabled = await owner.call(`/api/admin/users/${plainIdStr}/disable`, { method: 'POST' });
  check('the other account is disabled', disabled.status === 200, `${disabled.status} ${disabled.code ?? ''}`);

  const loginDisabled = await new Session().call('/api/auth/login', {
    body: { username: plainName, password },
  });
  check('a disabled account cannot sign in with the right password', loginDisabled.status === 403 && loginDisabled.code === 'account_disabled', `${loginDisabled.status} ${loginDisabled.code}`);

  const wrongPwDisabled = await new Session().call('/api/auth/login', {
    body: { username: plainName, password: 'wrong-password-here' },
  });
  check(
    'a wrong password on a disabled account still says invalid_credentials (no enumeration)',
    wrongPwDisabled.status === 401 && wrongPwDisabled.code === 'invalid_credentials',
    `${wrongPwDisabled.status} ${wrongPwDisabled.code}`,
  );

  const reEnabled = await owner.call(`/api/admin/users/${plainIdStr}/enable`, { method: 'POST' });
  check('the account can be re-enabled', reEnabled.status === 200, `${reEnabled.status}`);
  const loginAgain = await new Session().call('/api/auth/login', { body: { username: plainName, password } });
  check('and can sign in again', loginAgain.status === 200, `${loginAgain.status} ${loginAgain.code ?? ''}`);

  // ── 10. every action is attributed ──────────────────────────────────────
  console.log('\n10. the audit trail names who did what');
  const audit = await owner.call('/api/admin/events');
  const actioned = (audit.body?.events ?? []).filter((e: { actorUsername: string | null }) => e.actorUsername);
  for (const kind of ['lock.cleared', 'invite.minted', 'invite.revoked', 'session.revoked', 'user.disabled', 'user.enabled']) {
    const found = actioned.find((e: { kind: string }) => e.kind === kind);
    check(`${kind} recorded with an actor`, found?.actorUsername === ownerName, found ? String(found.actorUsername) : 'missing');
  }

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`);
  await closeDb();
  if (failures > 0) process.exitCode = 1;
}

void main();
