import { useQuery } from '@tanstack/react-query';
import { fetchChats } from '../lib/chats';

export function useChats() {
  return useQuery({ queryKey: ['chats'], queryFn: fetchChats });
}
