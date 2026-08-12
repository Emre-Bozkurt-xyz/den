/**
 * Unit tests for `mergeUserSettings` (docs/MEDIA_ATTACHMENTS.md §4.2/§4.3,
 * D11) — the whitelist + merge that stands between `users.settings` (a jsonb
 * bag) and both GET/PATCH /me. Pure function, no DB: importing `./auth.js`
 * pulls in `db/index.js`, but `postgres()` connects lazily, so no live
 * Postgres is required to exercise this.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_USER_SETTINGS } from '@den/shared';
import { mergeUserSettings } from './auth.js';

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
    const stored = { galleryShowSensitive: true };
    assert.deepEqual(mergeUserSettings(stored, undefined), { galleryShowSensitive: true });
  });

  test('an empty patch preserves stored settings (PATCH /me {settings:{}} must not wipe)', () => {
    const stored = { galleryShowSensitive: true };
    assert.deepEqual(mergeUserSettings(stored, {}), { galleryShowSensitive: true });
  });

  test('unknown keys in the patch are silently dropped, never persisted', () => {
    const result = mergeUserSettings({}, { galleryShowSensitive: true, notARealSetting: 'x' });
    assert.deepEqual(result, { galleryShowSensitive: true });
    assert.ok(!('notARealSetting' in result));
  });

  test('unknown keys in a stored value are silently dropped too', () => {
    const result = mergeUserSettings({ galleryShowSensitive: false, legacyJunk: 123 }, undefined);
    assert.deepEqual(result, { galleryShowSensitive: false });
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
    const result = mergeUserSettings({ galleryShowSensitive: 'yes' }, undefined);
    assert.deepEqual(result, DEFAULT_USER_SETTINGS);
  });

  test('a partial patch only overwrites the keys it names, preserving the rest of stored', () => {
    // Only one key exists today, but this guards the merge shape (spread
    // order: defaults < stored < patch) so a future second key can't regress it.
    const stored = { galleryShowSensitive: true };
    const result = mergeUserSettings(stored, {});
    assert.deepEqual(result, { galleryShowSensitive: true });
  });

  test('a patch value overrides a stored value for the same key', () => {
    const stored = { galleryShowSensitive: true };
    const result = mergeUserSettings(stored, { galleryShowSensitive: false });
    assert.deepEqual(result, { galleryShowSensitive: false });
  });
});
