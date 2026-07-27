import type { VaultStatusResponse } from '@den/shared';
import { api } from './api';

/** GET /integrations/vault/status (docs/EMBEDS.md §5.2/§5.3). */
export function fetchVaultStatus(): Promise<VaultStatusResponse> {
  return api<VaultStatusResponse>('/api/integrations/vault/status');
}

export function unlinkVault(): Promise<{ ok: true }> {
  return api('/api/integrations/vault/unlink', { method: 'POST' });
}

/** A full-page navigation, not a fetch — `/connect` immediately redirects to
 *  Vault's `/oauth/authorize`, which (after the user approves) redirects
 *  back to Den's own `/callback` and finally to the PWA root. A `fetch()`
 *  here would just receive the first redirect's response body; the browser
 *  itself needs to leave Den for the OAuth hop to work at all. */
export function connectVault(): void {
  window.location.assign('/api/integrations/vault/connect');
}
