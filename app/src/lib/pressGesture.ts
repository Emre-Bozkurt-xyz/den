/**
 * The press-and-hold state machine behind the GIF picker's favorite popover
 * (docs/GIF_FAVORITES.md §8.2).
 *
 * **Why this is a separate, pure module rather than a few refs inside the
 * component.** A picker tile's click *sends the GIF immediately* (docs/GIFS.md
 * D4, "picking is sending"). So if a completed long-press fails to suppress
 * its trailing click, a user reaching for "Favorite" instead fires that GIF
 * into a live chat where everyone sees it. That is the one failure in this
 * feature bad enough to be worth designing against, and a transition table
 * with tests beats three mutable refs whose interaction can only be checked by
 * hand on a device we half-own.
 *
 * The component still owns the *timer* (a `setTimeout` for `longPressMs`) and
 * the DOM; this owns only the decisions. `fire()` is what the timer calls when
 * it elapses.
 *
 * Modelled on `ChatView`'s inline bubble long-press, deliberately: the two are
 * the same gesture on different surfaces, and a user who learned the timing in
 * chat should not have to relearn it in the picker.
 */

export interface PressState {
  /** Where the pointer went down, or null when no gesture is in flight. */
  start: { x: number; y: number } | null;
  /** True between pointerdown and either the long-press firing or the gesture
   *  being cancelled — i.e. "the timer should be running". */
  armed: boolean;
  /** The long-press completed and the popover opened. */
  fired: boolean;
  /** The next click event must be swallowed rather than treated as a tap.
   *  This is the field that stops an accidental send. */
  suppressClick: boolean;
}

export const IDLE: PressState = { start: null, armed: false, fired: false, suppressClick: false };

/**
 * Pointer down on a tile.
 *
 * Note it clears `suppressClick` rather than preserving it. A previous gesture
 * can leave suppression armed with no click ever arriving — the popover opened
 * and the finger lifted outside the tile, so no click was dispatched to reset
 * it. Carrying that flag forward would silently swallow the *next* genuine tap,
 * and the GIF the user then picked would simply not send. Same reasoning as the
 * equivalent reset in `ChatView.onBubblePointerDown`.
 */
export function pressDown(x: number, y: number): PressState {
  return { start: { x, y }, armed: true, fired: false, suppressClick: false };
}

/**
 * Pointer moved. Past `slopPx` the gesture is re-read as a scroll (the picker
 * grid is a scroll container) or a drag, and the pending long-press is
 * abandoned — a popover opening under a moving finger is never what was meant.
 * Disarming here also means the click that follows is a normal tap, so a small
 * drift on the way to tapping still sends.
 */
export function pressMove(state: PressState, x: number, y: number, slopPx: number): PressState {
  if (!state.armed || !state.start) return state;
  const dx = x - state.start.x;
  const dy = y - state.start.y;
  if (Math.hypot(dx, dy) <= slopPx) return state;
  return { ...state, armed: false, start: null };
}

/** The long-press timer elapsed: open the popover, and arm suppression so the
 *  click that this same gesture is about to produce doesn't also send. */
export function pressFire(state: PressState): PressState {
  if (!state.armed) return state;
  return { ...state, armed: false, fired: true, suppressClick: true };
}

/**
 * A click arrived. Returns the next state plus whether it counts as a genuine
 * tap — `send: false` is the guard that keeps a long-press from sending.
 *
 * Suppression is consumed here (one click, one suppression) so a real tap
 * immediately afterwards still works.
 */
export function pressClick(state: PressState): { state: PressState; send: boolean } {
  if (state.suppressClick) return { state: IDLE, send: false };
  return { state: IDLE, send: true };
}

/** Pointer up, pointer cancel, or the list scrolling underneath. Disarms the
 *  pending timer but deliberately KEEPS `suppressClick`: if the long-press
 *  already fired, the click is still on its way and must still be swallowed. */
export function pressCancel(state: PressState): PressState {
  return { ...state, armed: false, start: null };
}
