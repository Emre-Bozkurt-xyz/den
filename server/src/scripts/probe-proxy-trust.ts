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

  // ── Phase 1: exhaust one forged identity ────────────────────────────────
  const ipA = forgedIp();
  console.log(`Phase 1 — 12 attempts, all claiming X-Forwarded-For: ${ipA}`);
  let sawLimit = false;
  for (let i = 1; i <= 12; i++) {
    const a = await attempt(ipA);
    if (i <= 3 || a.status === 429 || i === 12) render(`#${i}`, a);
    if (a.status === 429) {
      sawLimit = true;
      break;
    }
  }
  if (!sawLimit) {
    console.log('\n⚠ Never hit 429 in 12 tries — the limit may be higher than the 10/min in routes/auth.ts,');
    console.log('  or an edge layer is answering before Fastify. Read the headers above.\n');
  }

  // ── Phase 2: same probe, a different forged identity ────────────────────
  const ipB = forgedIp();
  console.log(`
Phase 2 — one attempt claiming a DIFFERENT X-Forwarded-For: ${ipB}`);
  const b = await attempt(ipB);
  render('rotated XFF', b);
  const xffIsTrusted = b.status !== 429;

  // ── Phase 3: the decisive test — a genuinely different source address ────
  //
  // ⚠️ Phases 1 and 2 leave from one machine, so "everyone shares one bucket"
  // and "the bucket is correctly keyed to my real address" look IDENTICAL from
  // here. Forcing IPv4 vs IPv6 gives the origin two different real clients,
  // which is what separates them. Without this the verdict is a guess — an
  // earlier version of this script got it wrong for exactly that reason.
  console.log('\nPhase 3 — the same request from a different real source address (v4 vs v6)');
  const [hasV4, hasV6] = await Promise.all([familyWorks(4), familyWorks(6)]);
  let secondSource: Attempt | null = null;
  if (hasV4 && hasV6) {
    // Exhaust over v6, then try v4 — a different address entirely.
    for (let i = 0; i < 14; i++) {
      const r = await attempt(null, 6);
      if (r.status === 429) break;
    }
    console.log('  exhausted the bucket over IPv6');
    secondSource = await attempt(null, 4);
    render('same request over IPv4', secondSource);
  } else {
    console.log(`  SKIPPED — need both families from this host (v4: ${hasV4}, v6: ${hasV6}).`);
    console.log('  Re-run from a host with dual-stack egress, or repeat from a phone on mobile data.');
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n─── verdict ───');
  if (!sawLimit) {
    console.log('INCONCLUSIVE — the limiter never engaged. Confirm the route limit is live first.');
  } else if (xffIsTrusted) {
    console.log('SPOOFABLE — a forged X-Forwarded-For buys a fresh bucket.');
    console.log('  Per-IP limiting on /auth/login provides no brute-force protection at all.');
    console.log('  Fix: pin TRUSTED_PROXY to the real hop; never leave Fastify trustProxy at `true`.');
  } else if (!secondSource) {
    console.log('PARTIAL — a forged header is correctly ignored, but without a second source');
    console.log('  address this cannot tell a per-client bucket from one global bucket.');
  } else if (secondSource.status === 429) {
    console.log('SHARED — a genuinely different client lands in the SAME exhausted bucket:');
    console.log('  the real client address is not reaching Fastify, so every member shares one');
    console.log('  allowance. One attacker can lock the whole circle out of logging in.');
    console.log('  Fix: set TRUSTED_PROXY to whichever header actually carries the client');
    console.log('  (GET /api/debug/client-ip says which), and keep the per-account throttle.');
  } else {
    console.log('PER-CLIENT — a forged header is ignored and a different real client gets its own');
    console.log('  bucket. Correct at this layer. The per-account throttle still matters: IP');
    console.log('  rotation is cheap, and the username is the key an attacker cannot rotate.');
  }
  console.log();
}

void main();
