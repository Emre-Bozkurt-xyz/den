import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, MessagesResponse } from '@den/shared';
import { mergeNewestPage, type MessagesCache } from './messageSync';

/** Minimal `Message` — only the fields `mergeNewestPage` reads (`id`) plus a
 *  `body` to tell the server's copy of a row from a stale cached one. */
function msg(id: string, body = `m${id}`): Message {
  return { id, body } as Message;
}
function page(ids: string[], nextCursor: string | null = null): MessagesResponse {
  return { messages: ids.map((id) => msg(id)), nextCursor };
}
function cache(pages: MessagesResponse[]): MessagesCache {
  return { pages, pageParams: pages.map((_, i) => (i === 0 ? null : 'x')) };
}
const ids = (c: MessagesCache) => c.pages.map((p) => p.messages.map((m) => m.id));

describe('mergeNewestPage: catching up after the app was idle', () => {
  test('new messages land on top of what was already loaded', () => {
    const before = cache([page(['30', '20', '10'])]);
    const after = mergeNewestPage(before, page(['50', '40', '30', '20', '10']));
    assert.deepEqual(ids(after), [['50', '40', '30', '20', '10']]);
  });

  test('older pages are left alone — only the fetched range is reconciled', () => {
    const before = cache([page(['30', '20'], '20'), page(['10', '5'])]);
    const after = mergeNewestPage(before, page(['40', '30', '20']));
    assert.deepEqual(ids(after), [['40', '30', '20'], ['10', '5']]);
  });

  test('a message deleted while we were away disappears', () => {
    // The server omits soft-deleted rows rather than tombstoning them, so
    // "absent from a page that covers its id" is the only signal there is.
    const before = cache([page(['30', '20', '10'])]);
    const after = mergeNewestPage(before, page(['30', '10']));
    assert.deepEqual(ids(after), [['30', '10']]);
  });

  test('an edit made while we were away replaces the cached copy', () => {
    const before = cache([page(['20', '10'])]);
    const edited: MessagesResponse = { messages: [msg('20', 'edited'), msg('10')], nextCursor: null };
    const after = mergeNewestPage(before, edited);
    assert.equal(after.pages[0]!.messages[0]!.body, 'edited');
  });

  test('a gap bigger than one page resets rather than stitching a hole', () => {
    const before = cache([page(['3', '2', '1'])]);
    const after = mergeNewestPage(before, page(['300', '200', '100'], '100'));
    assert.deepEqual(ids(after), [['300', '200', '100']]);
    assert.deepEqual(after.pageParams, [null], 'pagination must restart from the new page');
  });

  test('a chat emptied while we were away ends up empty', () => {
    const after = mergeNewestPage(cache([page(['2', '1'])]), page([]));
    assert.deepEqual(ids(after), [[]]);
  });

  test('no cache yet is just the page', () => {
    assert.deepEqual(ids(mergeNewestPage(undefined, page(['2', '1']))), [['2', '1']]);
  });

  test('an unchanged chat is a no-op', () => {
    const after = mergeNewestPage(cache([page(['2', '1'])]), page(['2', '1']));
    assert.deepEqual(ids(after), [['2', '1']]);
  });
});

describe('mergeNewestPage: local bubbles are never collateral damage', () => {
  test('a pending send survives a merge and stays pinned on top', () => {
    const before = cache([{ messages: [msg('pending:abc'), msg('20')], nextCursor: null }]);
    const after = mergeNewestPage(before, page(['30', '20']));
    assert.deepEqual(ids(after), [['pending:abc', '30', '20']]);
  });

  test('a failed send survives even the gap reset', () => {
    const before = cache([{ messages: [msg('failed:abc'), msg('2')], nextCursor: null }]);
    const after = mergeNewestPage(before, page(['300', '200']));
    assert.deepEqual(ids(after), [['failed:abc', '300', '200']]);
  });

  test('a pending send is not mistaken for the overlap that avoids a reset', () => {
    // Only real ids count as overlap: a cache holding nothing but a pending
    // bubble has no history to stitch to, so the page simply becomes the list.
    const before = cache([{ messages: [msg('pending:abc')], nextCursor: null }]);
    const after = mergeNewestPage(before, page(['9', '8']));
    assert.deepEqual(ids(after), [['pending:abc', '9', '8']]);
  });
});
