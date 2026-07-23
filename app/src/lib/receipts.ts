import type { ChatReceipt, Message, PublicUser } from '@den/shared';
import { isLocalId } from './realtime';

/** What `ChatView` threads into `MessageBlockRow` per docs/RECEIPTS.md §3/§5.4
 *  — computed once per render over the loaded page, not per-message, since
 *  every message's status/avatars fall out of the same watermark pass. */
export interface ReceiptDerivation {
  /** Seen markers, keyed by message id — Messenger-style: each other
   *  member's avatar sits under the *newest* of my messages they've read
   *  (their watermark, clamped down to a message I actually sent) — UNLESS
   *  that member has a later message of their own loaded, in which case
   *  their reply already proves they saw it and the marker is dropped as
   *  noise (owner revision 2026-07-23, docs/RECEIPTS.md §3). Capped at the
   *  model level not here — max-3-then-`+N` (and the 2-member-chat plain
   *  "Seen" text) are rendering concerns. */
  seenAvatars: Map<string, PublicUser[]>;
  /** "Sent"/"Delivered" for my newest non-local message only; `null` when
   *  there's no such message or it's *effectively seen* by ≥1 member —
   *  watermark past it, or a later message from them (their reply
   *  supersedes the receipt; without this, a stale "Delivered" would sit
   *  above their reply forever — docs/RECEIPTS.md §1/§3). */
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
function idGt(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * Derives per-message seen-avatars + status text from a chat's receipts and
 * its currently-loaded messages (docs/RECEIPTS.md §3). Pure — no fetching,
 * no caching — so `ChatView` (and this file's own tests) can call it plainly.
 *
 * "Sending implies seeing" (owner Q&A 2026-07-23): in this app a message can
 * only be composed from an open, visible chat, and opening a chat fires
 * markRead — so a member's own message is treated as proof they saw
 * everything before it, without needing a separate server-side rule. That
 * shows up here twice: a member's marker is suppressed when their own later
 * message is loaded, and the status text counts such members as seers.
 * (Placement itself still comes from the watermark alone: any position a
 * message-derived floor could add necessarily sits below that same message
 * and would be suppressed by the reply rule — so deriving it would be dead
 * code.)
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

  // Newest loaded real message per sender — feeds the reply-supersedes rule.
  // Oldest→newest input order means plain overwrite keeps the newest.
  const newestBySender = new Map<string, string>();
  for (const m of messages) {
    if (!isLocalId(m.id)) newestBySender.set(m.senderId, m.id);
  }

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
      if (!target) continue;

      // Reply supersedes receipt: their own later message already proves
      // they saw everything up to it — a marker underneath would be noise.
      // Per-member deliberately (not "any later message from anyone"): in a
      // group, B's reply says nothing about whether C looked, so C's marker
      // must survive B replying (docs/RECEIPTS.md §3).
      const ownNewest = newestBySender.get(r.userId);
      if (ownNewest && idGt(ownNewest, target.id)) continue;

      const list = seenAvatars.get(target.id);
      if (list) list.push(user);
      else seenAvatars.set(target.id, [user]);
    }
  }

  let status: ReceiptDerivation['status'] = null;
  const newestMine = myMessages[myMessages.length - 1] ?? null;
  if (newestMine) {
    // Effectively seen — by watermark OR by a later message of theirs (the
    // marker for such a member is suppressed above, so this can't reuse the
    // rendered-avatar check or a stale "Delivered" would outlive their reply).
    const effectivelySeen = members.some((u) => {
      if (u.id === meId) return false;
      const r = receipts.find((rr) => rr.userId === u.id);
      if (r?.lastReadMessageId != null && idGte(r.lastReadMessageId, newestMine.id)) return true;
      const ownNewest = newestBySender.get(u.id);
      return ownNewest !== undefined && idGt(ownNewest, newestMine.id);
    });
    if (!effectivelySeen) {
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
