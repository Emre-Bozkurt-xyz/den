import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, MessagesResponse } from '@den/shared';
import {
  applyServerMessage,
  insertMessages,
  localReqId,
  mergeNewestPage,
  reconcileOlderPage,
  type MessagesCache,
} from './messageSync';

/** Minimal `Message` — only the fields `mergeNewestPage` reads (`id`) plus a
 *  `body` to tell the server's copy of a row from a stale cached one. */
function msg(id: string, body = `m${id}`): Message {
  return { id, body } as Message;
}
/** The sender's own row as `GET /messages` returns it: nonce attached. */
function own(id: string, nonce: string): Message {
  return { id, body: `m${id}`, clientNonce: nonce } as Message;
}
function page(ids: string[], nextCursor: string | null = null): MessagesResponse {
  return { messages: ids.map((id) => msg(id)), nextCursor };
}
/** pageParams exactly as TanStack records them: page i was fetched with
 *  `before = pages[i-1].nextCursor`. */
function cache(pages: MessagesResponse[]): MessagesCache {
  return { pages, pageParams: pages.map((_, i) => (i === 0 ? null : pages[i - 1]!.nextCursor)) };
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

describe('mergeNewestPage: a send whose ack was lost (idempotent sends)', () => {
  test('a failed bubble is replaced by its delivered row, not shown beside it', () => {
    // The frame landed, the ack didn't, the 10s backstop flipped the bubble
    // to failed — then the resume page brings the real row back with our nonce.
    const before = cache([{ messages: [msg('failed:r1'), msg('20')], nextCursor: null }]);
    const after = mergeNewestPage(before, { messages: [own('30', 'r1'), msg('20')], nextCursor: null });
    assert.deepEqual(ids(after), [['30', '20']]);
  });

  test('a still-pending bubble is resolved the same way', () => {
    const before = cache([{ messages: [msg('pending:r1'), msg('20')], nextCursor: null }]);
    const after = mergeNewestPage(before, { messages: [own('30', 'r1'), msg('20')], nextCursor: null });
    assert.deepEqual(ids(after), [['30', '20']]);
  });

  test('and on the gap-reset path too', () => {
    const before = cache([{ messages: [msg('failed:r1'), msg('2')], nextCursor: null }]);
    const after = mergeNewestPage(before, { messages: [own('300', 'r1'), msg('200')], nextCursor: '200' });
    assert.deepEqual(ids(after), [['300', '200']]);
  });

  test('a bubble the page has no nonce for is a genuinely unsent message and stays', () => {
    const before = cache([{ messages: [msg('failed:r2'), msg('failed:r1'), msg('20')], nextCursor: null }]);
    const after = mergeNewestPage(before, { messages: [own('30', 'r1'), msg('20')], nextCursor: null });
    assert.deepEqual(ids(after), [['failed:r2', '30', '20']]);
  });

  test('a row restored while away lands on the page that owns its id, not on page 0', () => {
    // Page 0 owns [20, inf), page 1 owns (-inf, 20). 15 was restored meanwhile
    // and the newest page reached down to it.
    const before = cache([page(['30', '20'], '20'), page(['10'])]);
    const after = mergeNewestPage(before, page(['40', '30', '20', '15'], '15'));
    assert.deepEqual(ids(after), [['40', '30', '20'], ['15', '10']]);
  });

  test('a fetched row older than everything loaded is left for pagination (no later duplicate)', () => {
    const before = cache([page(['30', '20', '10'], '10')]);
    const after = mergeNewestPage(before, page(['30', '20', '10', '5'], '5'));
    assert.deepEqual(ids(after), [['30', '20', '10']]);
  });
});

describe('applyServerMessage: the message.new echo / ack', () => {
  test('replaces our pending bubble in place', () => {
    const before = cache([{ messages: [msg('pending:r1'), msg('20')], nextCursor: null }]);
    assert.deepEqual(ids(applyServerMessage(before, msg('30'), 'r1')!), [['30', '20']]);
  });

  test('a late ack after the timeout still replaces the failed bubble', () => {
    const before = cache([{ messages: [msg('failed:r1'), msg('20')], nextCursor: null }]);
    assert.deepEqual(ids(applyServerMessage(before, msg('30'), 'r1')!), [['30', '20']]);
  });

  test('if a catch-up already brought the row in, the bubble just goes away', () => {
    const before = cache([{ messages: [msg('failed:r1'), msg('30'), msg('20')], nextCursor: null }]);
    const after = applyServerMessage(before, msg('30', 'fresh'), 'r1')!;
    assert.deepEqual(ids(after), [['30', '20']]);
    assert.equal(after.pages[0]!.messages[0]!.body, 'fresh');
  });

  test('never inserts an id that is already cached, on any page', () => {
    const before = cache([page(['30', '20'], '20'), page(['10'])]);
    assert.deepEqual(ids(applyServerMessage(before, msg('10'))!), [['30', '20'], ['10']]);
  });

  test('another member’s new message goes on top; a reqId with no bubble is inert', () => {
    const before = cache([{ messages: [msg('pending:mine'), msg('20')], nextCursor: null }]);
    assert.deepEqual(ids(applyServerMessage(before, msg('30'), 'theirs')!), [['30', 'pending:mine', '20']]);
  });

  test('no cache yet stays no cache (the chat fetches when opened)', () => {
    assert.equal(applyServerMessage(undefined, msg('1'), 'r1'), undefined);
  });
});

describe('insertMessages: message.restored', () => {
  const twoPages = () => cache([page(['50', '40'], '40'), page(['30', '20'], '20')]);

  test('each restored row goes back onto the page that owns it, in order', () => {
    const after = insertMessages(twoPages(), [msg('45'), msg('25')])!;
    assert.deepEqual(ids(after), [['50', '45', '40'], ['30', '25', '20']]);
  });

  test('one older than anything loaded is left for pagination', () => {
    assert.deepEqual(ids(insertMessages(twoPages(), [msg('5')])!), [['50', '40'], ['30', '20']]);
  });

  test('unless the last page is the start of the chat', () => {
    const c = cache([page(['50', '40'], '40'), page(['30', '20'])]);
    assert.deepEqual(ids(insertMessages(c, [msg('5')])!), [['50', '40'], ['30', '20', '5']]);
  });

  test('an id already cached is replaced, not duplicated', () => {
    const after = insertMessages(twoPages(), [msg('30', 'restored')])!;
    assert.deepEqual(ids(after), [['50', '40'], ['30', '20']]);
    assert.equal(after.pages[1]!.messages[0]!.body, 'restored');
  });
});

describe('reconcileOlderPage: deeper pages after a resume', () => {
  // Page 0 owns [40, inf), page 1 owns [20, 40), page 2 owns (-inf, 20).
  const threePages = () => cache([page(['50', '40'], '40'), page(['30', '25', '20'], '20'), page(['10'])]);

  test('an edit made while away on an older message is applied', () => {
    const fetched: MessagesResponse = { messages: [msg('30', 'edited'), msg('25'), msg('20')], nextCursor: '20' };
    const after = reconcileOlderPage(threePages(), 1, fetched);
    assert.equal(after.pages[1]!.messages[0]!.body, 'edited');
    assert.deepEqual(ids(after), [['50', '40'], ['30', '25', '20'], ['10']]);
  });

  test('a delete made while away removes it; the fetch reaching into page 2 leaves page 2 alone', () => {
    // 25 deleted, so the page now reaches down to 10 — which is page 2's.
    const fetched: MessagesResponse = { messages: [msg('30'), msg('20'), msg('10', 'not-mine')], nextCursor: '10' };
    const after = reconcileOlderPage(threePages(), 1, fetched);
    assert.deepEqual(ids(after), [['50', '40'], ['30', '20'], ['10']]);
    assert.equal(after.pages[2]!.messages[0]!.body, 'm10');
  });

  test('a row restored while away is added to its page', () => {
    const fetched: MessagesResponse = { messages: [msg('35'), msg('30'), msg('25'), msg('20')], nextCursor: '20' };
    assert.deepEqual(ids(reconcileOlderPage(threePages(), 1, fetched)), [['50', '40'], ['35', '30', '25', '20'], ['10']]);
  });

  test('a full fetch that stops short of the page floor says nothing below it', () => {
    // Restores pushed the page over its limit: the fetch ends at 30, so 25/20
    // are outside what it covers and must not be read as deleted.
    const fetched: MessagesResponse = { messages: [msg('38'), msg('35'), msg('30')], nextCursor: '30' };
    assert.deepEqual(ids(reconcileOlderPage(threePages(), 1, fetched)), [['50', '40'], ['38', '35', '30', '25', '20'], ['10']]);
  });

  test('the last page with nothing left server-side empties', () => {
    assert.deepEqual(ids(reconcileOlderPage(threePages(), 2, page([]))), [['50', '40'], ['30', '25', '20'], []]);
  });

  test('page 0 is not its business', () => {
    const c = threePages();
    assert.equal(reconcileOlderPage(c, 0, page(['1'])), c);
  });
});

describe('localReqId', () => {
  test('strips either local prefix and ignores real ids', () => {
    assert.equal(localReqId('pending:abc'), 'abc');
    assert.equal(localReqId('failed:abc'), 'abc');
    assert.equal(localReqId('123'), null);
  });
});
