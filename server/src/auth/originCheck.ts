/**
 * Same-site request forgery guard.
 *
 * ⚠️ The session cookie is SameSite=Lax (auth/session.ts), and "site" means
 * the REGISTRABLE domain, not the origin: a page on any sibling subdomain of
 * the app's domain is *same-site*, so its cross-origin POSTs and WebSocket
 * handshakes carry Den's cookie and Lax does nothing to stop them. Checking
 * `Origin` closes that: browsers attach it to every cross-origin request and
 * every non-GET same-origin one, and a page cannot forge it.
 *
 * The rule, applied to state-changing REST requests (app.ts) and to the
 * socket.io handshake (ws.ts):
 *   - production + `Origin` present + not exactly PUBLIC_ORIGIN → refuse.
 *   - no `Origin` header → allow. Non-browser callers (curl, the probe
 *     scripts, socket.io-client under Node) send none, and a browser can't be
 *     induced to omit it on the requests this guards.
 *   - dev → allow. Vite (5173) proxies to the API (3000), and the dev socket
 *     already runs with permissive CORS; locking dev down would only break it.
 */

/** The exact origin string browsers send for PUBLIC_ORIGIN (scheme://host[:port],
 *  no path, no trailing slash). */
export function canonicalOrigin(publicOrigin: string): string {
  return new URL(publicOrigin).origin;
}

/** Is a request carrying this `Origin` header allowed? */
export function originAllowed(
  originHeader: string | string[] | undefined,
  opts: { isProd: boolean; publicOrigin: string },
): boolean {
  if (!opts.isProd) return true;
  if (originHeader === undefined) return true;
  // Node folds a repeated header into an array for some names; a request
  // claiming two origins is not one we can vouch for.
  if (Array.isArray(originHeader)) return false;
  // Exact string match against the canonical form. `Origin: null` (sandboxed
  // iframes, some redirects) is present and not ours, so it is refused.
  return originHeader === canonicalOrigin(opts.publicOrigin);
}

/** Methods that cannot change state (RFC 9110 "safe"), and so are not guarded. */
export function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}
