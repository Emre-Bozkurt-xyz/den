import { useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@den/shared';
import { fetchMe } from '../lib/auth';

/** The current-user query. `data === null` means "known logged out";
 *  `undefined` while loading. Server is the source of truth (hard invariant 3). */
export function useMe() {
  return useQuery<MeResponse | null>({
    queryKey: ['me'],
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: false,
  });
}
