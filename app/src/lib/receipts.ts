import type { ChatReceipt, Message, PublicUser } from '@den/shared';
import { isLocalId } from './realtime';

/** What `ChatView` threads into `MessageBlockRow` per docs/RECEIPTS.md §3/§5.4
 *  — computed once per render over the loaded page, not per-message, since
 *  every message's status/avatars fall out of the same watermark pass. */
export interface ReceiptDerivation {
  /** Seen avatars, keyed by message id — Messenger-style: each other
   *  member's avatar sits under the *newest* of my messages they've read
   *  (their watermark, clamped down to a message I actually sent). Capped at
   *  the model level not here — max-3-then-`+N` is a rendering concern. */
  seenAvatars: Map<string, PublicUser[]>;
  /** "Sent"/"Delivered" for my newest non-local message only; `null` when
   *  there's no such message or it already has ≥1 seen avatar (suppressed —
   *  the avatars say more, docs/RECEIPTS.md §1). */
  status: { messageId: string; kind: 'sent' | 'delivered' } | null;
}

/** BIGINT-as-string ids — compare only via BigInt(), never `<`/`>` on the raw
 *  strings (docs/RECEIPTS.md §3). */
function idLte(a: string, b: string): boolean {
  return BigInt(a) <= BigInt(b);
}
function idGte(a: string, b: string): boolean {
  return BigInt(a) >= BigInt(b);
}

/**
 * Derives per-message seen-avatars + status text from a chat's receipts and
 * its currently-loaded messages (docs/RECEIPTS.md §3). Pure — no fetching,
 * no caching — so `ChatView` (and this file's own tests) can call it plainly.
 *
 * @param messages oldest → newest (matches `flattenMessages`'s output; only
 *   the order matters here, not full-history completeness — receipts on a
 *   message that scrolled off the loaded page simply aren't derived, same as
 *   every other purely-client-side presentation concern in this app).
 * @param receipts every member's watermarks, viewer's row included (ignored
 *   here via the `r.userId === meId` skip — matches `ChatReceipt`'s own doc
 *   comment in @den/shared).
 * @param members the chat's members, used to resolve `PublicUser` for avatars
 *   and to compute the "all others" set for the Delivered rule.
 */
export function deriveReceipts(
  messages: Message[],
  receipts: ChatReceipt[],
  members: PublicUser[],
  meId: string,
): ReceiptDerivation {
  // Only my own real (server-assigned) messages participate — a `pending:`/
  // `failed:` bubble was never actually delivered/read by anyone server-side
  // (docs/RECEIPTS.md §5.4/§5.3).
  const myMessages = messages.filter((m) => m.senderId === meId && !isLocalId(m.id));

  const seenAvatars = new Map<string, PublicUser[]>();
  if (myMessages.length > 0) {
    const membersById = new Map(members.map((u) => [u.id, u]));
    for (const r of receipts) {
      if (r.userId === meId) continue; // the viewer's own row is never rendered
      if (r.lastReadMessageId === null) continue;
      const user = membersById.get(r.userId);
      if (!user) continue;

      // Watermark clamp: the newest of MY messages this member has read —
      // i.e. the last one with id <= their watermark. Iterating oldest→
      // newest and keeping the last match found is equivalent to (and
      // cheaper than) sorting, since `myMessages` is already ordered.
      let target: Message | null = null;
      for (const m of myMessages) {
        if (idLte(m.id, r.lastReadMessageId)) target = m;
      }
      if (target) {
        const list = seenAvatars.get(target.id);
        if (list) list.push(user);
        else seenAvatars.set(target.id, [user]);
      }
    }
  }

  let status: ReceiptDerivation['status'] = null;
  const newestMine = myMessages[myMessages.length - 1] ?? null;
  if (newestMine) {
    const alreadySeen = (seenAvatars.get(newestMine.id)?.length ?? 0) > 0;
    if (!alreadySeen) {
      const others = members.filter((u) => u.id !== meId);
      const allDelivered =
        others.length > 0 &&
        others.every((u) => {
          const r = receipts.find((rr) => rr.userId === u.id);
          return r?.lastDeliveredMessageId != null && idGte(r.lastDeliveredMessageId, newestMine.id);
        });
      status = { messageId: newestMine.id, kind: allDelivered ? 'delivered' : 'sent' };
    }
  }

  return { seenAvatars, status };
}
