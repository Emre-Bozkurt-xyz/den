/**
 * Real push delivery (BACKBONE §8, revised by docs/NOTIFICATIONS.md).
 * Subscriptions persist in `push_subscriptions`, keyed by user (routes/push.ts
 * writes them).
 *
 * ⚠️ **Who gets notified changed in 2026-08-23 and the old rule was wrong.**
 * This used to notify members with "no active WS connection to the chat",
 * reasoning that every socket joins all of its user's chat rooms on connect
 * (ws.ts), so "no socket in the room" is exactly "offline". The premise is
 * true and it is what makes the conclusion false: because a socket joins
 * *every* room, presence in `chat:{id}` says nothing about that chat — it
 * only says the user has a socket *somewhere*. A backgrounded Chrome PWA or a
 * forgotten desktop tab therefore silenced its own notifications
 * (docs/NOTIFICATIONS.md §2.1).
 *
 * The rule now: skip a member only if one of their sockets reports it is
 * **looking at this chat right now** (`realtime/presence.ts`). Everything
 * else gets a push — including an app that is open on a *different* chat
 * (§D1). Sockets that never report presence count as not-watching, so this
 * fails toward notifying.
 */
import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import type { Server as IOServer } from 'socket.io';
import type { EmbedProvider, Message } from '@den/shared';
import { db } from '../db/index.js';
import { chatMembers, chats, pushSubscriptions, users } from '../db/schema.js';
import { env } from '../env.js';
import { chatRoom } from '../realtime/rooms.js';
import { isWatching } from '../realtime/presence.js';

let configured = false;
function ensureVapid(): boolean {
  if (configured) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
  return true;
}

/**
 * Delivery hints (docs/NOTIFICATIONS.md §2.4) — neither was set before, and
 * both are part of why notifications felt unreliable.
 *
 * `urgency: 'high'` because FCM is free to batch and defer `normal`-urgency
 * pushes while a device is dozing, which is exactly the window a chat message
 * needs to survive. `TTL` of 12h because the library default is four weeks:
 * a day-old "hey" is noise, and a subscription that has been unreachable that
 * long is a subscription, not a delivery problem.
 */
const PUSH_TTL_SECONDS = 12 * 60 * 60;

interface SubRow {
  userId: bigint;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function subscriptionsForUsers(userIds: bigint[]): Promise<SubRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));
}

/** ⚠️ prune on 404/410 — iOS reinstalls churn subscriptions (BACKBONE §5).
 *  Everything else is logged rather than swallowed: a silently dropped 413 or
 *  a VAPID misconfiguration is indistinguishable from "the push worked and
 *  the phone ignored it", which is the hardest version of this bug to chase
 *  (docs/NOTIFICATIONS.md §2.4). */
async function sendOne(sub: SubRow, payload: string, topic: string): Promise<void> {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
      TTL: PUSH_TTL_SECONDS,
      urgency: 'high',
      // Push-service-side coalescing: an undelivered push for the same chat is
      // replaced rather than queued behind it, matching the client-side `tag`
      // in sw.ts. ≤32 URL-safe chars, which `chat-{bigint}` always is.
      topic,
    });
  } catch (e) {
    const code = (e as { statusCode?: number })?.statusCode;
    if (code === 404 || code === 410) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
      return;
    }
    console.error(`push send failed (status ${code ?? 'none'}):`, e instanceof Error ? e.message : e);
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

/**
 * What the notification is titled, from one recipient's point of view
 * (docs/NOTIFICATIONS.md §6). `null` means "a DM" — the SW then titles the
 * notification with the sender's name and drops the redundant `Sender:`
 * prefix from the body.
 *
 * Group fallback names exclude the recipient, which is the whole reason this
 * is computed per user rather than once per send: nobody should see their own
 * name listed in the notification telling them about their own group.
 */
function chatNameFor(
  chat: { isGroup: boolean; name: string | null },
  memberNames: Map<string, string>,
  recipientId: bigint,
): string | null {
  if (!chat.isGroup) return null;
  if (chat.name) return chat.name;
  const others = [...memberNames.entries()].filter(([id]) => id !== recipientId.toString()).map(([, name]) => name);
  return others.join(', ') || 'Group';
}

export async function notifyChatMembers(io: IOServer, chatId: bigint, message: Message): Promise<void> {
  if (!ensureVapid()) return; // not configured locally — skip quietly, not fatal to sending the message

  const memberRows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId));
  const senderId = BigInt(message.senderId);
  const chatIdStr = chatId.toString();

  // Sockets in the room are every socket belonging to a member (they all join
  // every room). The presence report is what narrows that to "is looking at
  // this chat" — see this module's header for why the room alone can't.
  const socketsInRoom = await io.in(chatRoom(chatId)).fetchSockets();
  const watchingUserIds = new Set(
    socketsInRoom.filter((s) => isWatching(s.data, chatIdStr)).map((s) => String((s.data as { userId: bigint }).userId)),
  );

  const targets = memberRows.map((m) => m.userId).filter((id) => id !== senderId && !watchingUserIds.has(String(id)));
  if (targets.length === 0) return;

  const [chatRows, memberUserRows, subs] = await Promise.all([
    db.select({ isGroup: chats.isGroup, name: chats.name }).from(chats).where(eq(chats.id, chatId)).limit(1),
    db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, memberRows.map((m) => m.userId))),
    subscriptionsForUsers(targets),
  ]);
  if (subs.length === 0) return;

  const chat = chatRows[0] ?? { isGroup: false, name: null };
  const memberNames = new Map(memberUserRows.map((u) => [u.id.toString(), u.displayName]));
  const senderName = memberNames.get(message.senderId) ?? 'Someone';
  const preview = previewFor(message);
  const topic = `chat-${chatIdStr}`;

  // One payload per recipient (the group-name fallback is recipient-relative),
  // reused across all of that user's devices.
  const payloadFor = new Map<string, string>();
  for (const userId of targets) {
    payloadFor.set(
      userId.toString(),
      JSON.stringify({
        chatId: chatIdStr,
        chatName: chatNameFor(chat, memberNames, userId),
        senderName,
        preview,
        // docs/NOTIFICATIONS.md §3 — the deep link. A launch parameter, not a
        // route: App.tsx consumes it on mount and wipes it back to `/`.
        url: `/?chat=${chatIdStr}`,
      }),
    );
  }

  await Promise.all(
    subs.map((s) => {
      const payload = payloadFor.get(s.userId.toString());
      return payload ? sendOne(s, payload, topic) : Promise.resolve();
    }),
  );
}
