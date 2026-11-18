/**
 * Push subscription endpoint validation.
 *
 * ⚠️ `POST /push/subscribe` used to store any string as an endpoint, and the
 * server later POSTs to every stored endpoint (push/notify.ts, /push/test).
 * That is a blind SSRF: any member could point Den's server at
 * `http://localhost:5432`, the VPS's metadata service, or anything else on the
 * private side of the network, and have it fire requests on a schedule they
 * control (every message in a chat they're in).
 *
 * The fix is an allowlist of the push services that real browsers hand out,
 * not a blocklist of "internal" addresses — DNS can point an innocent-looking
 * name anywhere, and a blocklist only ever covers the cases someone thought
 * of. Scheme, IP literals, credentials and length are checked too — always,
 * so the dev mode that skips the allowlist (and the port rule that goes with
 * it) still cannot be pointed at an internal address by IP.
 *
 * Which hosts the circle's devices actually use (PROJECT.md §12):
 *   - Chrome / Samsung Internet / Edge-on-Android / Opera / Brave → FCM
 *     (`fcm.googleapis.com`) — the Samsung dev device in Chrome.
 *   - Firefox (the dev device's other PWA install) → Mozilla autopush
 *     (`updates.push.services.mozilla.com`).
 *   - iOS/macOS Safari, incl. the installed iPhone PWA → APNs web push
 *     (`web.push.apple.com`, covered by `*.push.apple.com`).
 *   - Edge on Windows → WNS (`*.notify.windows.com`).
 * A device whose service isn't listed is refused at subscribe time with its
 * host logged (routes/push.ts) — extend the list below rather than loosening
 * the check.
 */
import { isIP } from 'node:net';

/** Exact hostnames. */
const EXACT_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];

/** Suffixes, matched as `*.suffix` — the leading dot is load-bearing: it is
 *  what stops `evilpush.apple.com.attacker.net` or `notpush.apple.com` from
 *  matching. */
const SUFFIX_HOSTS: readonly string[] = ['.push.apple.com', '.notify.windows.com'];

/** Real endpoints are a few hundred characters (WNS is the longest, ~300).
 *  The cap exists so the column and the log line stay bounded. */
export const PUSH_ENDPOINT_MAX = 2048;

/** p256dh is a base64url P-256 point (87 chars), auth a 16-byte secret (22).
 *  Generous ceilings — these only stop junk, the library rejects bad keys. */
export const PUSH_KEY_MAX = 256;

export type EndpointCheck =
  | { ok: true; host: string }
  | { ok: false; reason: string; host: string | null };

function hostAllowed(host: string): boolean {
  return EXACT_HOSTS.includes(host) || SUFFIX_HOSTS.some((s) => host.endsWith(s) && host.length > s.length);
}

/**
 * Validate a push endpoint. `enforceAllowlist` is true in production; dev
 * turns it off (host allowlist + default-port rule) so a local fake push
 * service (docs/NOTIFICATIONS.md §9) still works, while the scheme, IP-literal,
 * credential and length rules stay on everywhere.
 */
export function checkPushEndpoint(raw: unknown, enforceAllowlist: boolean): EndpointCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'missing', host: null };
  if (raw.length > PUSH_ENDPOINT_MAX) return { ok: false, reason: 'too long', host: null };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a URL', host: null };
  }
  const host = url.hostname.toLowerCase();

  if (url.protocol !== 'https:') return { ok: false, reason: 'not https', host };
  // Credentials in the URL have no business in a push endpoint, and are a
  // classic way to make a URL read as one host and resolve as another.
  if (url.username || url.password) return { ok: false, reason: 'credentials in URL', host };
  // Every push service listens on the default port. A non-default one is how
  // an endpoint reaches a service that was never meant to be addressed.
  // (`URL` already blanks an explicit `:443` on https, so any port here is
  // a non-default one.) Relaxed with the allowlist in dev, where a fake push
  // service on localhost needs some port.
  if (enforceAllowlist && url.port) return { ok: false, reason: 'non-default port', host };
  // `URL` normalizes decimal/hex/octal IPv4 forms ("2130706433") to dotted
  // quads and keeps IPv6 in brackets, so this catches all the disguises.
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return { ok: false, reason: 'IP literal host', host };
  if (enforceAllowlist && !hostAllowed(host)) return { ok: false, reason: 'host not in push allowlist', host };

  return { ok: true, host };
}
