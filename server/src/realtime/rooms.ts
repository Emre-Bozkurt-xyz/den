/**
 * socket.io room-name helpers. Standalone (no other project imports) so both
 * `ws.ts` and the push module can depend on it without a cycle.
 *
 *   user:{id}  — one user, all their tabs/devices; chat-agnostic notices
 *                (chat.created, friend.*).
 *   chat:{id}  — every member of that chat; message fanout target.
 */
export const chatRoom = (chatId: bigint | string): string => `chat:${chatId}`;
export const userRoom = (userId: bigint | string): string => `user:${userId}`;
