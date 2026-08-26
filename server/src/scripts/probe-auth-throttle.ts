/**
 * End-to-end check of the per-account login throttle
 * (docs/AUTH_HARDENING.md §2.2 / §4).
 *
 * Answers the three questions that decide whether the design works:
 *   1. Does an account actually lock after `threshold` failures?
 *   2. Does locking account A leave account B alone? (If not, the throttle has
 *      reintroduced the global-bucket outage it was built to remove.)
 *   3. Does the lock report a usable Retry-After / message?
 *
 * ⚠️ Point this at the dev stack, not prod: it deliberately drives a username
 * into a lock. The usernames are random `probe-*` values that cannot exist, so
 * no real account is touched — but it will consume the flood-backstop budget.
 *
 *   npx tsx server/src/scripts/probe-auth-throttle.ts http://localhost:3000
 */
import { randomBytes } from 'node:crypto';
import { LoginThrottle } from '@den/shared';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
const LOGIN = `${base}/api/auth/login`;

const user = () => `probe-${randomBytes(6).toString('hex')}`;

interface Res {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
}

async function login(username: string, password = 'definitely-not-the-password'): Promise<Res> {
  const res = await fetch(LOGIN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  let code: string | null = null;
  let message: string | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? null;
    message = body.error?.message ?? null;
  } catch {
    /* non-JSON — status is enough */
  }
  return { status: res.status, code, message, retryAfter: res.headers.get('retry-after') };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log(`\nProbing ${LOGIN}`);
  console.log(`threshold=${LoginThrottle.threshold} window=${LoginThrottle.windowMs / 60000}m\n`);

  const health = await fetch(`${base}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${base}/health did not answer OK — is the stack up?`);
    process.exitCode = 1;
    return;
  }

  const victim = user();
  const bystander = user();

  // ── 1. drive the victim to the threshold ────────────────────────────────
  console.log(`1. ${LoginThrottle.threshold} failed logins for "${victim}"`);
  let locked: Res | null = null;
  for (let i = 1; i <= LoginThrottle.threshold + 2; i++) {
    const r = await login(victim);
    if (r.status === 423) {
      locked = r;
      console.log(`   locked after ${i} attempts`);
      break;
    }
    if (r.status !== 401) {
      console.log(`   unexpected status ${r.status} (${r.code}) at attempt ${i}`);
      break;
    }
  }
  check('account locks after repeated failures', locked !== null, locked ? `423 ${locked.code}` : 'never locked');
  if (locked) {
    check('lock uses the auth_locked code', locked.code === 'auth_locked', String(locked.code));
    check('lock sends Retry-After', locked.retryAfter !== null, `Retry-After: ${locked.retryAfter}`);
    check('lock message tells the user when to retry', /\d+\s*minute/.test(locked.message ?? ''), locked.message ?? '');
  }

  // ── 2. the bystander must be untouched ──────────────────────────────────
  // This is the regression that matters most: the whole reason for a
  // per-account throttle is that the previous global bucket let one attacker
  // lock out everybody. If this fails, we rebuilt that bug.
  console.log(`\n2. a different account ("${bystander}") during the lock`);
  const b = await login(bystander);
  check('bystander is NOT locked out', b.status === 401 && b.code === 'invalid_credentials', `${b.status} ${b.code}`);

  // ── 3. clearing ─────────────────────────────────────────────────────────
  console.log('\n3. clearing');
  console.log(`   run:  npm run auth:unlock clear ${victim}`);
  console.log('   then re-run this probe — attempt 1 should be 401, not 423.');

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`);
  if (failures > 0) process.exitCode = 1;
}

void main();
