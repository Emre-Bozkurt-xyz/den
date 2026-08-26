/**
 * Passkey client (docs/PASSKEYS.md §8).
 *
 * `@simplewebauthn/browser` is a thin wrapper over `navigator.credentials`
 * that handles the base64url encoding the raw API demands. It is a bundled
 * import, not a CDN script, so hard invariant 10 is satisfied.
 *
 * ⚠️ **Both ceremonies must be started from a direct user gesture.** Never
 * call these from an effect, a redirect, or after an `await` that could break
 * the gesture chain — iOS in particular will refuse, and it fails as a silent
 * or cryptic error rather than a clear "no". This is the same rule that
 * governs push permission (PROJECT.md §12).
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  AuthResponse,
  PasskeyCeremonyOptions,
  PasskeyListResponse,
} from '@den/shared';
import { api } from './api';

/** True when this browser can do platform passkeys at all. Used to hide the
 *  entry points rather than offer a button that can only fail. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

/**
 * Thrown when the *user* ended the ceremony — cancelled the sheet, let it time
 * out, or the browser refused. Distinguished from a server rejection because
 * it is not an error worth showing: the user knows what they just did.
 */
export class PasskeyCancelled extends Error {
  constructor() {
    super('passkey ceremony cancelled');
    this.name = 'PasskeyCancelled';
  }
}

/** WebAuthn surfaces user cancellation and several unrelated conditions as the
 *  same DOMException names, which is unhelpful but stable enough to branch on. */
function isCancellation(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** Register a passkey on THIS device for the signed-in account. */
export async function addPasskey(label?: string): Promise<void> {
  const options = await api<PasskeyCeremonyOptions>('/api/auth/passkey/register/options', {
    method: 'POST',
  });

  let response: unknown;
  try {
    // The options bag is deliberately opaque end to end (shared/api.ts): the
    // library owns the WebAuthn shape, and restating it here would be a mirror
    // that can only drift from the code that actually parses it. Cast through
    // `unknown` at the one seam where it meets the typed library.
    response = await startRegistration({
      optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
    });
  } catch (err) {
    if (isCancellation(err)) throw new PasskeyCancelled();
    throw err;
  }

  await api('/api/auth/passkey/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response, label }),
  });
}

/**
 * Sign in with a passkey. No username argument — the credential is
 * discoverable, so the authenticator picks the account.
 */
export async function loginWithPasskey(): Promise<AuthResponse> {
  const options = await api<PasskeyCeremonyOptions>('/api/auth/passkey/login/options', {
    method: 'POST',
  });

  let response: unknown;
  try {
    // Same opaque-bag seam as addPasskey above.
    response = await startAuthentication({
      optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
    });
  } catch (err) {
    if (isCancellation(err)) throw new PasskeyCancelled();
    throw err;
  }

  return api<AuthResponse>('/api/auth/passkey/login/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

export function listPasskeys(): Promise<PasskeyListResponse> {
  return api<PasskeyListResponse>('/api/auth/passkey/credentials');
}

export function renamePasskey(id: string, label: string): Promise<void> {
  return api(`/api/auth/passkey/credentials/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  });
}

export function removePasskey(id: string): Promise<void> {
  return api(`/api/auth/passkey/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
