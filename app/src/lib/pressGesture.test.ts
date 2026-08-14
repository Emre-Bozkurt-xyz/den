import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE, pressCancel, pressClick, pressDown, pressFire, pressMove } from './pressGesture';

const SLOP = 10;

/**
 * docs/GIF_FAVORITES.md §11 — the first item in that verification list, and the
 * reason this module exists at all: in the GIF picker a tile's click SENDS the
 * GIF immediately (docs/GIFS.md D4). A long-press that fails to swallow its
 * trailing click doesn't just open the wrong thing — it fires a GIF into a live
 * chat that everybody in it can see.
 */
describe('press gesture: a long-press must never send', () => {
  test('a completed long-press opens the popover and swallows the click', () => {
    let s = pressDown(100, 100);
    s = pressFire(s);
    assert.equal(s.fired, true, 'popover should open');

    const { send } = pressClick(s);
    assert.equal(send, false, 'the click after a long-press must NOT send');
  });

  test('a plain tap still sends', () => {
    let s = pressDown(100, 100);
    // Real fingers wobble a pixel or two; inside the slop that is still a tap.
    s = pressMove(s, 102, 101, SLOP);
    s = pressCancel(s); // pointerup, timer never elapsed
    assert.equal(pressClick(s).send, true);
  });

  test('suppression is consumed, so the very next tap sends', () => {
    let s = pressFire(pressDown(10, 10));
    const first = pressClick(s);
    assert.equal(first.send, false);

    // Without consuming suppression the user's next pick would silently do
    // nothing — the failure mode that looks like "the picker is broken".
    s = pressDown(20, 20);
    assert.equal(pressClick(s).send, true);
  });

  test('a stale suppression from a gesture whose click never arrived is cleared on the next press', () => {
    // Long-press fires, finger lifts outside the tile: no click is dispatched,
    // so nothing consumed the flag.
    const stale = pressFire(pressDown(10, 10));
    assert.equal(stale.suppressClick, true);

    const next = pressDown(50, 50);
    assert.equal(next.suppressClick, false);
    assert.equal(pressClick(next).send, true, 'the next genuine tap must still send');
  });
});

describe('press gesture: cancellation', () => {
  test('moving past the slop disarms the long-press', () => {
    let s = pressDown(100, 100);
    s = pressMove(s, 100, 100 + SLOP + 1, SLOP);
    assert.equal(s.armed, false, 'a scroll must not arm a popover');

    // And the timer firing after that is inert — the component clears the
    // timeout, but the state machine must not depend on it having done so.
    s = pressFire(s);
    assert.equal(s.fired, false);
    assert.equal(pressClick(s).send, true, 'a drifted tap is still a tap');
  });

  test('movement within the slop keeps the long-press armed', () => {
    let s = pressDown(100, 100);
    s = pressMove(s, 105, 103, SLOP);
    assert.equal(s.armed, true);
    assert.equal(pressFire(s).fired, true);
  });

  test('cancel keeps suppression when the long-press already fired', () => {
    // pointercancel / scroll arriving between the popover opening and the
    // click. The click is still coming, so the guard must survive.
    const s = pressCancel(pressFire(pressDown(10, 10)));
    assert.equal(s.suppressClick, true);
    assert.equal(pressClick(s).send, false);
  });

  test('cancel before firing leaves a normal tap intact', () => {
    const s = pressCancel(pressDown(10, 10));
    assert.equal(s.suppressClick, false);
    assert.equal(pressClick(s).send, true);
  });

  test('move and fire are inert from idle', () => {
    assert.deepEqual(pressMove(IDLE, 50, 50, SLOP), IDLE);
    assert.deepEqual(pressFire(IDLE), IDLE);
  });
});
