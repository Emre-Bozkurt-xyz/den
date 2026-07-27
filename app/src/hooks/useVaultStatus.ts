import { useQuery } from '@tanstack/react-query';
import type { VaultStatusResponse } from '@den/shared';
import { fetchVaultStatus } from '../lib/vault';

/** docs/EMBEDS.md §5.3 — Profile's "Connect Vault" section reads this.
 *  Refetches on window focus (the default) so returning from the Vault
 *  OAuth redirect (a full-page round trip, not an SPA navigation) picks up
 *  the newly-linked state without a manual refresh. */
export function useVaultStatus() {
  return useQuery<VaultStatusResponse>({
    queryKey: ['vaultStatus'],
    queryFn: fetchVaultStatus,
    staleTime: 30_000,
  });
}
