import { useQuery } from '@tanstack/react-query';
import { fetchFriends } from '../lib/friends';

export function useFriends() {
  return useQuery({ queryKey: ['friends'], queryFn: fetchFriends });
}
