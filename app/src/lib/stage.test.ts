/**
 * Pure unit tests for the Stage's picker-query clamping and grid ordering
 * (docs/EMBEDS.md §6.2.1/§7 Contract B2) — mirrors `lib/receipts.test.ts`'s
 * plain `node:test` setup for a pure function, no DOM/network.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { StageLimits, type StageDoc } from '@den/shared';
import { clampPickerQuery, sortStageDocs } from './stage';

function doc(id: string, updatedAt: string | null, addedAt: string): StageDoc {
  return {
    id,
    vaultDocumentId: `v-${id}`,
    title: `Doc ${id}`,
    ownerName: null,
    snippet: null,
    updatedAt,
    canEdit: true,
    addedBy: null,
    addedAt,
  };
}

describe('clampPickerQuery', () => {
  test('trims surrounding whitespace', () => {
    assert.equal(clampPickerQuery('  hello  '), 'hello');
  });

  test('passes short queries through untouched', () => {
    assert.equal(clampPickerQuery('roadmap'), 'roadmap');
  });

  test('clamps to StageLimits.maxPickerQueryLength', () => {
    const long = 'a'.repeat(StageLimits.maxPickerQueryLength + 50);
    const clamped = clampPickerQuery(long);
    assert.equal(clamped.length, StageLimits.maxPickerQueryLength);
    assert.equal(clamped, 'a'.repeat(StageLimits.maxPickerQueryLength));
  });

  test('trims before clamping so whitespace never eats into the budget', () => {
    const padded = ' '.repeat(10) + 'a'.repeat(StageLimits.maxPickerQueryLength);
    assert.equal(clampPickerQuery(padded).length, StageLimits.maxPickerQueryLength);
  });
});

describe('sortStageDocs', () => {
  test('orders by updatedAt, most recent first', () => {
    const docs = [doc('a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), doc('b', '2026-03-01T00:00:00Z', '2026-01-02T00:00:00Z')];
    assert.deepEqual(sortStageDocs(docs).map((d) => d.id), ['b', 'a']);
  });

  test('docs with null updatedAt sort after docs with a real timestamp', () => {
    const docs = [doc('unresolved', null, '2026-05-01T00:00:00Z'), doc('resolved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')];
    assert.deepEqual(sortStageDocs(docs).map((d) => d.id), ['resolved', 'unresolved']);
  });

  test('null-updatedAt docs among themselves fall back to add order (newest add first)', () => {
    const docs = [doc('first-added', null, '2026-01-01T00:00:00Z'), doc('second-added', null, '2026-01-02T00:00:00Z')];
    assert.deepEqual(sortStageDocs(docs).map((d) => d.id), ['second-added', 'first-added']);
  });

  test('does not mutate the input array', () => {
    const docs = [doc('a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), doc('b', '2026-03-01T00:00:00Z', '2026-01-02T00:00:00Z')];
    const copy = [...docs];
    sortStageDocs(docs);
    assert.deepEqual(docs, copy);
  });
});
