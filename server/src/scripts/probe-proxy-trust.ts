/**
 * Diagnostic: does the login rate limit actually key on the real client?
 *
 * Den sits behind an upstream TLS terminator → frp tunnel → Caddy → Fastify,
 * and Fastify runs with `trustProxy` (app.ts). `@fastify/rate-limit` keys on
 * `req.ip`, which under trust-all is the LEFTMOST `X-Forwarded-For` entry —
 * a value the client sends. This probe decides empirically which of three
 * worlds we're in:
 *
 *   SPOOFABLE  — rotating a forged XFF resets the bucket. Per-IP limiting on
 *                /auth/login is decorative; an attacker guesses without bound.
 *   SHARED     — the forged XFF is ignored AND every caller lands in one
 *                bucket. Then a single attacker locks out the whole circle.
 *   SOUND      — the forged XFF is ignored and distinct real clients get
 *                distinct buckets. Nothing to fix at this layer.
 *
 * Safe to run against prod: it only ever POSTs a random, syntactically valid
 * username that cannot exist (`probe-<random>`), so it burns rate-limit budget
 * for one window and touches no real account's failure counters.
 *
 * Usage:
 *   npx tsx server/src/scripts/probe-proxy-trust.ts https://den.ems-place.com
 *   npx tsx server/src/scripts/probe-proxy-trust.ts            # → localhost:3000
 */
import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');
const LOGIN = `${base}/api/auth/login`;

/** A username that passes validation (a–z0–9_-, 3–32) and cannot exist. */
function probeUser(): string {
  return `probe-${randomBytes(6).toString('hex')}`;
}

/** A random public-looking IPv4 to forge as the client address. */
function forgedIp(): string {
  const b = randomBytes(4);
  return `203.0.${b[2]! % 254}.${(b[3]! % 254) + 1}`; // TEST-NET-3, never routable
}

interface Attempt {
  status: number;
  code: string | null;
  limit: string | null;
  remaining: string | null;
  reset: string | null;
}

/**
 * One login attempt. `family` pins the IP version so we can reach the origin
 * from two genuinely different source addresses — which is the ONLY way to
 * tell "one shared bucket" apart from "correctly keyed to my address" when
 * every request leaves the same machine. `fetch` can't pin family, hence the
 * stdlib client.
 */
function attempt(xff: string | null, family?: 4 | 6): Promise<Attempt> {
  const url = new URL(LOGIN);
  const body = JSON.stringify({ username: probeUser(), password: 'not-a-real-password' });
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  if (xff) headers['x-forwarded-for'] = xff;

  return new Promise((resolve, reject) => {
    const req = send(
      { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST', headers, family },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let code: string | null = null;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { error?: { code?: string } };
            code = parsed.error?.code ?? null;
          } catch {
            /* non-JSON (an edge error page) — status alone tells the story */
          }
          const h = (n: string): string | null => {
            const v = res.headers[n];
            return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
          };
          resolve({
            status: res.statusCode ?? 0,
            code,
            limit: h('x-ratelimit-limit'),
            remaining: h('x-ratelimit-remaining'),
            reset: h('x-ratelimit-reset'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Can we actually reach the origin over this family? */
async function familyWorks(family: 4 | 6): Promise<boolean> {
  try {
    await attempt(null, family);
    return true;
  } catch {
    return false;
  }
}

function render(label: string, a: Attempt): void {
  const rl = a.limit ? `${a.remaining}/${a.limit} left, reset ${a.reset}s` : 'no rate-limit headers';
  console.log(`  ${label.padEnd(28)} ${String(a.status).padEnd(4)} ${(a.code ?? '-').padEnd(20)} ${rl}`);
}

async function main(): Promise<void> {
  console.log(`\nProbing ${LOGIN}\n`);

  // Reachability first, so a network failure doesn't read as a security finding.
  const health = await fetch(`${base}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${base}/health did not answer OK — check the URL/tunnel before reading anything below.`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ /health OK\n');

  // ── Phase 1: is a forged X-Forwarded-For believed? ──────────────────────
  //
  // Measured by whether it moves the bucket, not by exhausting it. ⚠️ An
  // earlier version of this script drove the limiter to 429 with a hardcoded
  // 12 attempts, which silently stopped proving anything the day the ceiling
  // rose from 10/min to 120 — it just reported INCONCLUSIVE forever. Reading
  // the counter is both cheaper and immune to the limit changing.
  const ipA = forgedIp();
  console.log(`Phase 1 — does a forged X-Forwarded-For get its own bucket? (claiming ${ipA})`);
  const base1 = await attempt(null);
  const forged1 = await attempt(ipA);
  render('no XFF', base1);
  render('forged XFF', forged1);

  if (!base1.limit) {
    console.log('\n⚠ No rate-limit headers at all — either the route limit is off, or an edge');
    console.log('  layer is answering before Fastify. Nothing below can be trusted.\n');
    process.exitCode = 1;
    return;
  }

  const limit = Number(base1.limit);
  const r1 = Number(base1.remaining);
  const r2 = Number(forged1.remaining);
  // A forged identity that is TRUSTED gets a fresh bucket, so its `remaining`
  // jumps back near the ceiling instead of continuing the previous count.
  const xffIsTrusted = r2 > r1;

  // ── Phase 2: do two genuinely different clients share a bucket? ─────────
  //
  // ⚠️ This is the check that separates "one global bucket" from "correctly
  // keyed per client", and it CANNOT be done from a single address — every
  // request would look the same either way. Forcing IPv4 vs IPv6 gives the
  // origin two real, different clients. An earlier verdict here was wrong for
  // exactly that reason.
  console.log('\nPhase 2 — do IPv4 and IPv6 (two real, different clients) share a bucket?');
  const [hasV4, hasV6] = await Promise.all([familyWorks(4), familyWorks(6)]);
  if (!hasV4 || !hasV6) {
    console.log(`  SKIPPED — need both families from this host (v4: ${hasV4}, v6: ${hasV6}).`);
    console.log('  Re-run from a dual-stack host, or repeat the check from a phone on mobile data.');
    console.log('\n─── verdict ───');
    console.log(xffIsTrusted
      ? 'SPOOFABLE — a forged X-Forwarded-For buys a fresh bucket. Pin TRUSTED_PROXY.'
      : 'PARTIAL — the forged header is ignored, but without a second source address');
    if (!xffIsTrusted) console.log('  this cannot tell a per-client bucket from one global bucket.');
    console.log();
    return;
  }

  const beforeV4 = await attempt(null, 4);
  const SPEND = 5;
  for (let i = 0; i < SPEND; i++) await attempt(null, 6);
  const afterV4 = await attempt(null, 4);
  render('IPv4 before', beforeV4);
  render(`IPv4 after ${SPEND} IPv6 requests`, afterV4);

  const spentOnV4 = Number(beforeV4.remaining) - Number(afterV4.remaining);
  // Only this probe's own two v4 requests should have moved the v4 counter.
  // If the v6 traffic moved it too, everyone is in one bucket.
  const shared = spentOnV4 > SPEND;

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n─── verdict ───');
  console.log(`  limit ${limit}/min · v4 counter moved by ${spentOnV4} across ${SPEND} v6 requests + 1 v4 request`);
  if (xffIsTrusted) {
    console.log('SPOOFABLE — a forged X-Forwarded-For buys a fresh bucket.');
    console.log('  Per-IP limiting on /auth/login provides no brute-force protection at all.');
    console.log('  Fix: pin TRUSTED_PROXY to the real hop; never leave Fastify trustProxy at `true`.');
    process.exitCode = 1;
  } else if (shared) {
    console.log('SHARED — IPv6 traffic drained the IPv4 bucket, so every caller shares one');
    console.log('  allowance. The real client address is not reaching Fastify, and one attacker');
    console.log('  can lock the whole circle out of signing in.');
    console.log('  Fix: set TRUSTED_PROXY to whichever header carries the client');
    console.log('  (GET /api/debug/client-ip says which).');
    process.exitCode = 1;
  } else {
    console.log('PER-CLIENT ✓ — a forged header is ignored, and two different real clients get');
    console.log('  separate buckets. Correct at this layer.');
    console.log('  The per-account throttle still matters: address rotation is cheap, and the');
    console.log('  username is the one key an attacker cannot rotate.');
  }
  console.log();
}

void main();
