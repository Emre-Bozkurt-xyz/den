/**
 * Sign-in freeze checks (docs/SIGNIN_FREEZE.md §7).
 *
 * Two properties carry the design and both are easy to get wrong silently:
 *
 *   - **An existing session keeps working.** If freezing signed people out it
 *     would be the opposite of the feature, and nothing in the login path
 *     would reveal that — only holding a session across the toggle does.
 *   - **The freeze is not an enumeration oracle.** A WRONG password on a
 *     frozen account must still say `invalid_credentials`, or the error itself
 *     tells a stranger which usernames exist and which are locked down.
 *
 * ⚠️ Dev stack only.
 *
 *   PROBE_INVITES=<c1>,<c2> npx tsx server/src/scripts/probe-freeze.ts http://localhost:3001
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { setGlobalFreeze } from '../auth/freeze.js';
import { Authenticator } from './lib/softAuthenticator.js';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = 'probe-password-1234';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const rnd = (): string => randomBytes(5).toString('hex');

interface Res {
  status: number;
  code: string | null;
  message: string | null;
  cookie: string | null;
}

async function login(username: string, password = PASSWORD): Promise<Res> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : null;
  const setCookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('den_session='));
  return {
    status: res.status,
    code: body?.error?.code ?? null,
    message: body?.error?.message ?? null,
    cookie: setCookie ?? null,
  };
}

async function register(username: string, inviteCode: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, displayName: username, inviteCode }),
  });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status}`);
  const c = (res.headers.getSetCookie?.() ?? [])
    .map((x) => x.split(';')[0]!)
    .find((x) => x.startsWith('den_session='));
  if (!c) throw new Error('no cookie');
  return c;
}

async function meWith(cookie: string): Promise<number> {
  const res = await fetch(`${base}/api/me`, { headers: { cookie } });
  return res.status;
}


/** Drive a full passkey sign-in ceremony and report how it ended. */
async function passkeyLogin(authr: Authenticator, rpId: string): Promise<{ status: number; code: string | null }> {
  const optRes = await fetch(`${base}/api/auth/passkey/login/options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const setCookie = (optRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).join('; ');
  const opts = (await optRes.json()) as { challenge: string };
  const res = await fetch(`${base}/api/auth/passkey/login/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: setCookie },
    body: JSON.stringify({ response: authr.authenticate(rpId, opts.challenge) }),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as { error?: { code?: string } }) : null;
  return { status: res.status, code: body?.error?.code ?? null };
}

async function main(): Promise<void> {
  console.log(`\nProbing ${base}\n`);
  const health = await fetch(`${base}/health`).catch(() => null);
  if (!health?.ok) {
    console.error('✗ health check failed');
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const codes = (process.env.PROBE_INVITES ?? '').split(',').filter(Boolean);
  if (codes.length < 2) {
    console.error('✗ set PROBE_INVITES=<c1>,<c2>');
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const aName = `fz-a-${rnd()}`;
  const bName = `fz-b-${rnd()}`;
  const aCookie = await register(aName, codes[0]!);
  await register(bName, codes[1]!);
  const aRow = await db.select({ id: users.id }).from(users).where(eq(users.username, aName)).limit(1);
  const aId = aRow[0]!.id;

  // Make someone an owner so the error message can name a person.
  await db.update(users).set({ isOwner: true }).where(eq(users.username, bName));

  console.log(`accounts: ${aName} (will be frozen), ${bName} (owner, stays open)\n`);

  // ── 1. baseline ─────────────────────────────────────────────────────────
  console.log('1. before any freeze');
  const before = await login(aName);
  check('sign-in works', before.status === 200, `${before.status} ${before.code ?? ''}`);

  // ── 2. per-user freeze ──────────────────────────────────────────────────
  console.log('\n2. freeze this one account');
  await db.update(users).set({ loginsFrozenAt: new Date() }).where(eq(users.id, aId));

  const frozen = await login(aName);
  check('correct password is refused', frozen.status === 403 && frozen.code === 'signin_frozen', `${frozen.status} ${frozen.code}`);
  check('the message names someone to contact', (frozen.message ?? '').includes(bName), frozen.message ?? '');
  check('no session cookie was issued', frozen.cookie === null);

  // ⚠️ THE enumeration check. A frozen account must not answer differently to
  // a wrong password than any other account would.
  const wrong = await login(aName, 'definitely-not-the-password');
  check(
    'a WRONG password still says invalid_credentials (no oracle)',
    wrong.status === 401 && wrong.code === 'invalid_credentials',
    `${wrong.status} ${wrong.code}`,
  );

  // ── 3. existing sessions survive ────────────────────────────────────────
  //
  // The property the whole design rests on: freezing bolts the door, it does
  // not sweep the building.
  console.log('\n3. the session issued BEFORE the freeze still works');
  check('the pre-freeze session is still valid', (await meWith(aCookie)) === 200);
  check('a session from registration is still valid', (await meWith(aCookie)) === 200);

  // ── 4. other accounts are unaffected ────────────────────────────────────
  console.log('\n4. a per-user freeze does not touch anyone else');
  const other = await login(bName);
  check('the other account signs in normally', other.status === 200, `${other.status} ${other.code ?? ''}`);

  // ── 5. the global switch ────────────────────────────────────────────────
  console.log('\n5. the global switch freezes an account with no flag of its own');
  await db.update(users).set({ loginsFrozenAt: null }).where(eq(users.id, aId));
  check('unfreezing the account restores sign-in', (await login(aName)).status === 200);

  await setGlobalFreeze(true, null);
  const globalFrozen = await login(aName);
  check('global freeze blocks it', globalFrozen.status === 403 && globalFrozen.code === 'signin_frozen', `${globalFrozen.status} ${globalFrozen.code}`);
  const ownerFrozen = await login(bName);
  check('global freeze blocks the owner too', ownerFrozen.status === 403, `${ownerFrozen.status}`);

  // ⚠️ Lifting the global switch must not clear a per-user freeze set
  // independently — two switches, neither knowing about the other.
  console.log('\n6. lifting the global switch preserves per-user freezes');
  await db.update(users).set({ loginsFrozenAt: new Date() }).where(eq(users.id, aId));
  await setGlobalFreeze(false, null);
  const stillFrozen = await login(aName);
  check('the per-user freeze survived the global lift', stillFrozen.status === 403 && stillFrozen.code === 'signin_frozen', `${stillFrozen.status} ${stillFrozen.code}`);
  check('the account with no flag is open again', (await login(bName)).status === 200);

  // ── 7. the audit trail ──────────────────────────────────────────────────
  console.log('\n7. blocked sign-ins are recorded');
  const bCookie = (await login(bName)).cookie!;
  const events = await fetch(`${base}/api/admin/events`, { headers: { cookie: bCookie } });
  const body = (await events.json()) as { events?: { kind: string; username: string | null }[] };
  const blocked = (body.events ?? []).filter((e) => e.kind === 'signin.blocked');
  check('signin.blocked events exist', blocked.length > 0, `${blocked.length}`);
  check('...naming the account that was blocked', blocked.some((e) => e.username === aName));

  // ── 8. a passkey is not an exemption ────────────────────────────────────
  //
  // ⚠️ The check this feature could most plausibly be missing. A passkey proves
  // identity beautifully and says nothing about whether the door is bolted; if
  // it walked through the freeze, the owner would believe sign-ins were shut
  // while every enrolled device still had a key. Nothing in the password path
  // would reveal that.
  console.log('\n8. a valid passkey is refused while frozen');
  // § 6 deliberately leaves this account frozen (that is its whole point), so
  // open it back up before enrolling: you cannot register a passkey without a
  // session, and you cannot get a session while frozen.
  await db.update(users).set({ loginsFrozenAt: null }).where(eq(users.id, aId));
  const rpId = new URL(base).hostname;
  const authr = new Authenticator(base);

  // Enrol against the (currently open) account, using its live session.
  const openLogin = await login(aName);
  const aSession = openLogin.cookie;
  if (openLogin.status !== 200 || !aSession) {
    check('could sign in to enrol a passkey', false, `${openLogin.status} ${openLogin.code}`);
  } else {
    const optRes = await fetch(`${base}/api/auth/passkey/register/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aSession },
      body: '{}',
    });
    // ⚠️ The challenge rides a signed cookie set by /options, and /verify checks
    // it. Sending only the session cookie drops it, and the ceremony fails as a
    // generic `passkey_failed` — which looks exactly like a broken signature.
    const optCookies = (optRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!);
    const enrolCookies = [aSession, ...optCookies].join('; ');
    const opts = (await optRes.json()) as { challenge: string };
    const verifyRes = await fetch(`${base}/api/auth/passkey/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: enrolCookies },
      body: JSON.stringify({ response: authr.register(rpId, opts.challenge), label: 'probe' }),
    });
    check('passkey enrolled while open', verifyRes.status === 201, String(verifyRes.status));

    // Passkey login works before the freeze...
    const before1 = await passkeyLogin(authr, rpId);
    check('passkey sign-in works before the freeze', before1.status === 200, `${before1.status} ${before1.code}`);

    // ...and must NOT after it.
    await db.update(users).set({ loginsFrozenAt: new Date() }).where(eq(users.id, aId));
    const after1 = await passkeyLogin(authr, rpId);
    check(
      'passkey sign-in is refused while frozen',
      after1.status === 403 && after1.code === 'signin_frozen',
      `${after1.status} ${after1.code}`,
    );
    await db.update(users).set({ loginsFrozenAt: null }).where(eq(users.id, aId));
  }

  // Tidy: leave nothing frozen behind.
  await db.update(users).set({ loginsFrozenAt: null }).where(eq(users.id, aId));
  await setGlobalFreeze(false, null);

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`);
  await closeDb();
  if (failures > 0) process.exitCode = 1;
}

void main();
