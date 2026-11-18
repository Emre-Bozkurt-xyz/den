import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { holdBusy, isBusy, onBusyChange } from './busy';
import { createReloadGate } from './reloadGate';

/**
 * lib/pwa.ts's update reload: a deploy must not reload the page over a
 * draft, staged attachments or an upload — but the reload must still happen,
 * exactly once, as soon as nothing blocks it.
 */
function setup() {
  let hidden = false;
  let reloads = 0;
  const gate = createReloadGate({
    isUploading: () => isBusy('upload'),
    isBusy: () => isBusy(),
    isHidden: () => hidden,
    reload: () => reloads++,
  });
  // Synchronous stand-in for pwa.ts's grace-timer wiring.
  const unsubscribe = onBusyChange(() => gate.attempt());
  return {
    gate,
    setHidden(v: boolean) {
      hidden = v;
      gate.attempt();
    },
    reloads: () => reloads,
    unsubscribe,
  };
}

describe('reload gate', () => {
  test('nothing busy: reloads immediately, as before', () => {
    const s = setup();
    s.gate.request();
    assert.equal(s.reloads(), 1);
    s.unsubscribe();
  });

  test('never reloads without an update having been requested', () => {
    const s = setup();
    const release = holdBusy('composer');
    release();
    s.setHidden(true);
    assert.equal(s.reloads(), 0);
    s.unsubscribe();
  });

  test('a draft defers the reload until it clears', () => {
    const s = setup();
    const release = holdBusy('composer');
    s.gate.request();
    assert.equal(s.reloads(), 0);
    release();
    assert.equal(s.reloads(), 1);
    s.unsubscribe();
  });

  test('going hidden overrides a draft, but not an upload', () => {
    const s = setup();
    const releaseDraft = holdBusy('composer');
    const releaseUpload = holdBusy('upload');
    s.gate.request();
    s.setHidden(true);
    assert.equal(s.reloads(), 0, 'an upload in flight must survive the page going hidden');
    releaseUpload();
    assert.equal(s.reloads(), 1, 'upload settled while hidden → reload, draft notwithstanding');
    releaseDraft();
    assert.equal(s.reloads(), 1, 'reloads exactly once');
    s.unsubscribe();
  });

  test('visible again before anything clears: still waits', () => {
    const s = setup();
    const release = holdBusy('upload');
    s.gate.request();
    s.setHidden(true);
    s.setHidden(false);
    assert.equal(s.reloads(), 0);
    release();
    assert.equal(s.reloads(), 1);
    s.unsubscribe();
  });
});

describe('busy holds', () => {
  test('release is idempotent — a double cleanup cannot free another hold', () => {
    const a = holdBusy('upload');
    const b = holdBusy('upload');
    a();
    a();
    assert.equal(isBusy('upload'), true, "b's hold must survive a's double release");
    b();
    assert.equal(isBusy(), false);
  });

  test('kinds are tracked separately', () => {
    const c = holdBusy('composer');
    assert.equal(isBusy(), true);
    assert.equal(isBusy('upload'), false);
    c();
    assert.equal(isBusy('composer'), false);
  });

  test('a throwing listener does not break release', () => {
    const off = onBusyChange(() => {
      throw new Error('boom');
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const r = holdBusy('upload');
      assert.doesNotThrow(r);
      assert.equal(isBusy(), false);
    } finally {
      console.error = originalError;
      off();
    }
  });
});
