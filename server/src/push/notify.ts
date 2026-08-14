/**
 * Real push delivery (BACKBONE §8) — replaces the Stage 0 in-memory PoC store.
 * Subscriptions persist in `push_subscriptions`, keyed by user (routes/push.ts
 * writes them). A new message notifies members who have **no active WS
 * connection** to the chat: every socket joins all of its user's chat rooms
 * on connect (ws.ts), so "no socket in the room" is exactly "offline" per §8.
 */
import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import type { Server as IOServer } from 'socket.io';
import type { EmbedProvider, Message } from '@den/shared';
import { db } from '../db/index.js';
import { chatMembers, pushSubscriptions, users } from '../db/schema.js';
import { env } from '../env.js';
import { chatRoom } from '../realtime/rooms.js';

let configured = false;
function ensureVapid(): boolean {
  if (configured) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
  return true;
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function subscriptionsForUsers(userIds: bigint[]): Promise<SubRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));
}

/** ⚠️ prune on 404/410 — iOS reinstalls churn subscriptions (BACKBONE §5). */
async function sendOne(sub: SubRow, payload: string): Promise<void> {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
  } catch (e) {
    const code = (e as { statusCode?: number })?.statusCode;
    if (code === 404 || code === 410) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
    }
  }
}

const MEDIA_LABEL: Record<'image' | 'video' | 'voice', string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  voice: '🎤 Voice message',
};

// docs/MEDIA_ATTACHMENTS.md §6: "Push preview: unchanged, and now one push
// per album instead of N" — same album-count wording as the reply-preview
// label (chat/replies.ts). Voice is never staged into an album (§6), so it
// has no plural form.
const MEDIA_LABEL_ALBUM: Partial<Record<'image' | 'video' | 'voice', (n: number) => string>> = {
  image: (n) => `📷 ${n} photos`,
  video: (n) => `🎥 ${n} videos`,
};

// docs/EMBEDS.md — same "media with no caption still needs a readable
// preview" rule as MEDIA_LABEL above.
const EMBED_LABEL: Record<EmbedProvider, string> = {
  instagram: '🎬 Instagram reel',
  vault: '📄 Vault doc',
  // docs/GIFS.md §13 — a GIF message always has an empty body (D4), so this
  // label is the ENTIRE notification text, never a fallback.
  klipy: '🖼️ GIF',
};

function previewFor(message: Message): string {
  if (message.media.length > 0) {
    const first = message.media[0]!;
    const label =
      message.media.length > 1 ? (MEDIA_LABEL_ALBUM[first.kind]?.(message.media.length) ?? MEDIA_LABEL[first.kind]) : MEDIA_LABEL[first.kind];
    return message.body?.trim() || label;
  }
  if (message.embed) return message.body?.trim() || EMBED_LABEL[message.embed.provider];
  return message.body?.slice(0, 120) ?? '';
}

export async function notifyChatMembers(io: IOServer, chatId: bigint, message: Message): Promise<void> {
  if (!ensureVapid()) return; // not configured locally — skip quietly, not fatal to sending the message

  const memberRows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId));
  const senderId = BigInt(message.senderId);

  const socketsInRoom = await io.in(chatRoom(chatId)).fetchSockets();
  const onlineUserIds = new Set(socketsInRoom.map((s) => String((s.data as { userId: bigint }).userId)));

  const offlineTargets = memberRows.map((m) => m.userId).filter((id) => id !== senderId && !onlineUserIds.has(String(id)));
  if (offlineTargets.length === 0) return;

  const [senderRows, subs] = await Promise.all([
    db.select({ displayName: users.displayName }).from(users).where(eq(users.id, senderId)).limit(1),
    subscriptionsForUsers(offlineTargets),
  ]);

  const payload = JSON.stringify({
    chatId: chatId.toString(),
    senderName: senderRows[0]?.displayName ?? 'Someone',
    preview: previewFor(message),
    url: '/',
  });

  await Promise.all(subs.map((s) => sendOne(s, payload)));
}
