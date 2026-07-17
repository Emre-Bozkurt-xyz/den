import type { FriendsResponse, SendFriendRequestBody } from '@den/shared';
import { api } from './api';

export function fetchFriends(): Promise<FriendsResponse> {
  return api<FriendsResponse>('/api/friends');
}

export function sendFriendRequest(body: SendFriendRequestBody): Promise<{ ok: true; status: 'pending' | 'accepted' }> {
  return api('/api/friends/requests', { method: 'POST', body: JSON.stringify(body) });
}

export function acceptFriendRequest(userId: string): Promise<{ ok: true }> {
  return api(`/api/friends/requests/${userId}/accept`, { method: 'POST' });
}

export function declineFriendRequest(userId: string): Promise<{ ok: true }> {
  return api(`/api/friends/requests/${userId}/decline`, { method: 'POST' });
}
