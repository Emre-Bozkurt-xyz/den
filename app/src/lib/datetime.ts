/**
 * Shared `Intl`-based time/date formatting (UI-8b/8c,
 * docs/UI8_CHAT_INSTAGRAM.md) — the one place divider labels
 * (`lib/messageGroups.ts`'s `buildTimeline`) and the action-menu send-time
 * header (`ChatView`'s bottom sheet + `MessageFocusMenu`) compute "what does
 * this timestamp mean to a human" from a `Message.createdAt` ISO string. No
 * date library — `Intl.DateTimeFormat` covers everything this needs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Calendar-day difference (`b` minus `a`), not a raw `ms / DAY_MS` division —
 *  DST transitions make some local days 23 or 25 hours long, which a naive
 *  division would get wrong right at the boundary. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const monthDayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthDayYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** `true` iff `iso` falls on today's calendar day (local time). */
export function isToday(iso: string): boolean {
  return daysBetween(new Date(iso), new Date()) === 0;
}

/** `true` iff both timestamps fall on the same calendar day (local time). */
export function isSameCalendarDay(isoA: string, isoB: string): boolean {
  return daysBetween(new Date(isoA), new Date(isoB)) === 0;
}

/** "4:23 PM" — locale time-of-day, no date component. */
export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** The date-divider label for a run boundary (UI-8b request D): "Yesterday",
 *  a weekday name within the last 7 days, else "MMM D" (or "MMM D, YYYY" if
 *  not this year).
 *
 *  Deliberately never returns anything for "today" — Instagram shows a time,
 *  not a "Today" header, at a same-day boundary (top-of-chat or a same-day
 *  gap). Callers are expected to check `isToday`/`isSameCalendarDay`
 *  themselves and prefer `formatTime` in that case (see
 *  `lib/messageGroups.ts`'s `buildTimeline`, the only caller); this function
 *  falls back to `formatTime` defensively if it's ever called for today or a
 *  (clock-skew) future date anyway, rather than printing a date label for
 *  "today" that would read like a bug. */
export function formatDateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = daysBetween(d, now);
  if (diff <= 0) return formatTime(iso);
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return weekdayFormatter.format(d);
  return d.getFullYear() === now.getFullYear() ? monthDayFormatter.format(d) : monthDayYearFormatter.format(d);
}

/** Action-/focus-menu send-time header (UI-8c request E): full time, plus
 *  the date when it's not today — "4:23 PM" or "Jul 12, 4:23 PM". */
export function formatSendTime(iso: string): string {
  if (isToday(iso)) return formatTime(iso);
  return `${formatDateLabel(iso)}, ${formatTime(iso)}`;
}
