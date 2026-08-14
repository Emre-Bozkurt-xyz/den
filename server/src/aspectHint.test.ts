/**
 * Unit tests for the shared aspect hint (docs/GIFS.md §6,
 * docs/MEDIA_ATTACHMENTS.md §4.6). Pure function, no DB, no network.
 *
 * These are the only client-declared measurements either feature accepts, so
 * the point of every case below is the same: a hostile or malformed hint must
 * only ever be able to produce a sane box.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aspectHint } from './aspectHint.js';

const aspectOf = (d: { width: number; height: number }) => d.width / d.height;

describe('aspectHint', () => {
  test('preserves a normal aspect ratio', () => {
    const wide = aspectHint(480, 270)!; // 16:9
    assert.ok(Math.abs(aspectOf(wide) - 16 / 9) < 0.02);

    const tall = aspectHint(220, 394)!;
    assert.ok(Math.abs(aspectOf(tall) - 220 / 394) < 0.02);

    const square = aspectHint(300, 300)!;
    assert.ok(Math.abs(aspectOf(square) - 1) < 0.02);
  });

  test('normalizes to a fixed nominal width, so the output is a ratio not a pixel claim', () => {
    // Same shape declared at wildly different scales must land identically —
    // nothing downstream should be able to read the client's pixel numbers
    // back out.
    assert.deepEqual(aspectHint(100, 50), aspectHint(4000, 2000));
  });

  test('clamps absurd ratios instead of reserving a screen-tall box', () => {
    // The actual abuse case: a 1x100000 "GIF" would otherwise reserve a box
    // hundreds of screens tall in everyone else's chat.
    const sliver = aspectHint(1, 100000)!;
    assert.ok(aspectOf(sliver) >= 1 / 5 - 0.01, `aspect ${aspectOf(sliver)} should be clamped up to 1/5`);
    assert.ok(sliver.height <= 240 * 5 + 1);

    const banner = aspectHint(100000, 1)!;
    assert.ok(aspectOf(banner) <= 5 + 0.01, `aspect ${aspectOf(banner)} should be clamped down to 5`);
  });

  test('rejects non-numbers, so a malformed frame degrades to a square', () => {
    for (const bad of [undefined, null, '480', {}, [], true, () => 1]) {
      assert.equal(aspectHint(bad, 270), undefined);
      assert.equal(aspectHint(480, bad), undefined);
    }
  });

  test('rejects non-finite and non-positive values', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -100]) {
      assert.equal(aspectHint(bad, 270), undefined, `width ${bad}`);
      assert.equal(aspectHint(480, bad), undefined, `height ${bad}`);
    }
  });

  test('always returns positive integers when it returns anything', () => {
    for (const [w, h] of [
      [1, 1],
      [7, 3],
      [1, 100000],
      [100000, 1],
      [0.5, 0.25],
    ] as const) {
      const d = aspectHint(w, h)!;
      assert.ok(Number.isInteger(d.width) && d.width > 0);
      assert.ok(Number.isInteger(d.height) && d.height > 0);
    }
  });
});
