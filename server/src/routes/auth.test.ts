/**
 * Unit tests for `mergeUserSettings` (docs/MEDIA_ATTACHMENTS.md §4.2/§4.3,
 * D11) — the whitelist + merge that stands between `users.settings` (a jsonb
 * bag) and both GET/PATCH /me. Pure function, no DB: importing `./auth.js`
 * pulls in `db/index.js`, but `postgres()` connects lazily, so no live
 * Postgres is required to exercise this.
 *
 * Expectations are written as `withDefaults({...})` rather than whole literal
 * objects. The bag is designed to keep gaining keys (that is the entire point
 * of D11), and hardcoding the complete shape made every one of these tests
 * fail the day `gifRating` was added — noise that says nothing about the merge
 * logic actually under test.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@den/shared';
import { mergeUserSettings } from './auth.js';

const withDefaults = (overrides: Partial<UserSettings> = {}): UserSettings => ({ ...DEFAULT_USER_SETTINGS, ...overrides });

describe('mergeUserSettings', () => {
  test('undefined/empty stored + undefined patch falls back to defaults', () => {
    assert.deepEqual(mergeUserSettings(undefined, undefined), DEFAULT_USER_SETTINGS);
    assert.deepEqual(mergeUserSettings({}, undefined), DEFAULT_USER_SETTINGS);
    assert.deepEqual(mergeUserSettings(null, undefined), DEFAULT_USER_SETTINGS);
  });

  test('non-object stored values (string, number, array) fall back to defaults', () => {
    assert.deepEqual(mergeUserSettings('not-an-object', undefined), DEFAULT_USER_SETTINGS);
    assert.deepEqual(mergeUserSettings(42, undefined), DEFAULT_USER_SETTINGS);
    assert.deepEqual(mergeUserSettings(['nope'], undefined), DEFAULT_USER_SETTINGS);
  });

  test('a valid stored value round-trips when there is no patch', () => {
    assert.deepEqual(mergeUserSettings({ galleryShowSensitive: true }, undefined), withDefaults({ galleryShowSensitive: true }));
  });

  test('an empty patch preserves stored settings (PATCH /me {settings:{}} must not wipe)', () => {
    assert.deepEqual(mergeUserSettings({ galleryShowSensitive: true }, {}), withDefaults({ galleryShowSensitive: true }));
  });

  test('unknown keys in the patch are silently dropped, never persisted', () => {
    const result = mergeUserSettings({}, { galleryShowSensitive: true, notARealSetting: 'x' });
    assert.deepEqual(result, withDefaults({ galleryShowSensitive: true }));
    assert.ok(!('notARealSetting' in result));
  });

  test('unknown keys in a stored value are silently dropped too', () => {
    const result = mergeUserSettings({ galleryShowSensitive: false, legacyJunk: 123 }, undefined);
    assert.deepEqual(result, withDefaults({ galleryShowSensitive: false }));
  });

  test('wrong-typed known key in the patch is rejected with a validation error', () => {
    assert.throws(
      () => mergeUserSettings({}, { galleryShowSensitive: 'true' }),
      (err: unknown) => err instanceof Error && /galleryShowSensitive/.test(err.message),
    );
    assert.throws(() => mergeUserSettings({}, { galleryShowSensitive: 1 }));
    assert.throws(() => mergeUserSettings({}, { galleryShowSensitive: null }));
  });

  test('a non-object patch (string/number/array) is rejected outright', () => {
    assert.throws(() => mergeUserSettings({}, 'nope'));
    assert.throws(() => mergeUserSettings({}, 42));
    assert.throws(() => mergeUserSettings({}, ['nope']));
  });

  test('wrong-typed known key in a stored value is dropped, not thrown (defaults fill the gap)', () => {
    assert.deepEqual(mergeUserSettings({ galleryShowSensitive: 'yes' }, undefined), DEFAULT_USER_SETTINGS);
  });

  test('a partial patch only overwrites the keys it names, preserving the rest of stored', () => {
    // Now genuinely multi-key (docs/GIFS.md §9 added `gifRating`), so this
    // finally tests what it always claimed to: spread order defaults < stored
    // < patch, with an unnamed stored key surviving the patch untouched.
    const stored = { galleryShowSensitive: true, gifRating: 'r' };
    const result = mergeUserSettings(stored, { gifRating: 'g' });
    assert.deepEqual(result, withDefaults({ galleryShowSensitive: true, gifRating: 'g' }));
  });

  test('a patch value overrides a stored value for the same key', () => {
    const result = mergeUserSettings({ galleryShowSensitive: true }, { galleryShowSensitive: false });
    assert.deepEqual(result, withDefaults({ galleryShowSensitive: false }));
  });

  // ── enum-valued settings (docs/GIFS.md §9 / D9) ──────────────────────────
  // `typeof` alone can't police these: every arbitrary string passes a
  // `typeof value === 'string'` check, so without SETTINGS_ENUMS a client
  // could persist `gifRating: 'anything'` and the outbound Klipy call would
  // carry junk. These tests are the guard on that.

  test('every declared gif rating is accepted', () => {
    for (const rating of ['g', 'pg', 'pg-13', 'r', 'off']) {
      assert.deepEqual(mergeUserSettings({}, { gifRating: rating }), withDefaults({ gifRating: rating as UserSettings['gifRating'] }));
    }
  });

  test('an out-of-domain gif rating is rejected even though it IS a string', () => {
    assert.throws(
      () => mergeUserSettings({}, { gifRating: 'x-rated' }),
      (err: unknown) => err instanceof Error && /gifRating/.test(err.message),
    );
    assert.throws(() => mergeUserSettings({}, { gifRating: '' }));
    assert.throws(() => mergeUserSettings({}, { gifRating: 'PG-13' })); // case-sensitive
  });

  test('an out-of-domain STORED gif rating is dropped rather than thrown', () => {
    // Same asymmetry as the wrong-typed stored case above: a bad stored value
    // must never make GET /me fail for that user, it just loses the setting.
    assert.deepEqual(mergeUserSettings({ gifRating: 'nc-17' }, undefined), DEFAULT_USER_SETTINGS);
  });
});
