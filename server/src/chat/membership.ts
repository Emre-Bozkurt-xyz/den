/**
 * Chat membership check (CLAUDE.md hard invariant 1): every chat-scoped REST
 * route and WS handler calls `assertMember` before touching chat data. This is
 * the app's entire authorization model — no exceptions.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chatMembers } from '../db/schema.js';
import { forbidden } from '../errors.js';

export async function isMember(userId: bigint, chatId: bigint): Promise<boolean> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function assertMember(userId: bigint, chatId: bigint): Promise<void> {
  if (!(await isMember(userId, chatId))) throw forbidden('Not a member of this chat');
}
