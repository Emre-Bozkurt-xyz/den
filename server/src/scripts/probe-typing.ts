/**
 * Typing indicator checks (docs/TYPING_INDICATORS.md §5).
 *
 * The one that matters is §3 below: the **server** emitting `typing: false`
 * on its own after the expiry, with no client help. Every stuck-indicator bug
 * is that defence missing, and it is the only one a client-driven test cannot
 * exercise — a probe that politely sends `typing: false` proves nothing about
 * the case where the client is gone.
 *
 * ⚠️ Dev stack only.
 *
 *   PROBE_INVITES=<c1>,<c2>,<c3> npx tsx server/src/scripts/probe-typing.ts http://localhost:3001
 */
import { randomBytes } from 'node:crypto';
import { io as ioClient, type Socket } from 'socket.io-client';
import { TypingTimings, WsType, makeEnvelope, type WsEnvelope } from '@den/shared';
import { closeDb } from '../db/index.js';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const rnd = (): string => randomBytes(5).toString('hex');

/** Register an account and return its session cookie. */
async function register(username: string, inviteCode: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'probe-password-1234', displayName: username, inviteCode }),
  });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status}`);
  const raw = res.headers.getSetCookie?.() ?? [];
  const den = raw.map((c) => c.split(';')[0]!).find((c) => c.startsWith('den_session='));
  if (!den) throw new Error(`no session cookie for ${username}`);
  return den;
}

/** ⚠️ `any` for the parsed body, deliberately (CLAUDE.md: justify every one) —
 *  a probe pokes at several unrelated response shapes, and typing each would
 *  mean importing every DTO for no benefit. Nothing here ships to a client. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callAs(cookie: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A connected socket that records every frame it receives. */
interface Client {
  socket: Socket;
  frames: WsEnvelope[];
}

function connect(cookie: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(base, {
      transports: ['websocket'],
      extraHeaders: { cookie },
    });
    const frames: WsEnvelope[] = [];
    socket.on('ws', (f: WsEnvelope) => frames.push(f));
    socket.on('connect', () => resolve({ socket, frames }));
    socket.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function typingFrames(c: Client, chatId: string): WsEnvelope[] {
  return c.frames.filter(
    (f) => f.type === WsType.TypingState && (f.payload as { chatId?: string })?.chatId === chatId,
  );
}

async function main(): Promise<void> {
  console.log(`\nProbing ${base}\n`);
  const health = await fetch(`${base}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${base}/health did not answer OK`);
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const codes = (process.env.PROBE_INVITES ?? '').split(',').filter(Boolean);
  if (codes.length < 3) {
    console.error('✗ set PROBE_INVITES=<c1>,<c2>,<c3>');
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const aName = `ty-a-${rnd()}`;
  const bName = `ty-b-${rnd()}`;
  const cName = `ty-c-${rnd()}`;
  const aCookie = await register(aName, codes[0]!);
  const bCookie = await register(bName, codes[1]!);
  const cCookie = await register(cName, codes[2]!);

  const bMe = await callAs(bCookie, '/api/me');
  const aMe = await callAs(aCookie, '/api/me');

  // A chat can only contain friends, so befriend first. Mutual-pending
  // auto-accepts (PROJECT.md §6), so two requests are all it takes.
  await callAs(aCookie, '/api/friends/requests', { username: bName });
  await callAs(bCookie, '/api/friends/requests', { username: aName });
  void aMe;

  const chat = await callAs(aCookie, '/api/chats', { memberIds: [bMe.body.id] });
  if (chat.status !== 200 && chat.status !== 201) {
    console.error(`✗ could not create a chat: ${chat.status} ${JSON.stringify(chat.body)}`);
    process.exitCode = 1;
    await closeDb();
    return;
  }
  const chatId: string = chat.body.id;
  console.log(`chat ${chatId} between ${aName} and ${bName}; ${cName} is NOT a member\n`);

  const a = await connect(aCookie);
  const b = await connect(bCookie);
  const c = await connect(cCookie);
  await sleep(300); // let room joins settle

  // ── 1. a member sees a member ───────────────────────────────────────────
  console.log('1. a member sees another member typing');
  a.socket.emit('ws', makeEnvelope(WsType.TypingUpdate, { chatId, typing: true }));
  await sleep(400);

  const bSaw = typingFrames(b, chatId);
  check('B received typing.state', bSaw.length > 0, `${bSaw.length} frames`);
  check('...saying typing: true', (bSaw[0]?.payload as { typing?: boolean })?.typing === true);

  // ⚠️ The sender must not be told about their own typing — `socket.to()` not
  // `io.to()`. Getting this wrong is invisible in a two-person test unless
  // asserted, and it doubles the traffic in a group.
  check('A did NOT receive its own typing echo', typingFrames(a, chatId).length === 0);

  // ── 2. a non-member learns nothing and can inject nothing ───────────────
  console.log('\n2. a non-member is shut out (hard invariant 1)');
  check('C received nothing', typingFrames(c, chatId).length === 0, `${typingFrames(c, chatId).length}`);

  const bBefore = typingFrames(b, chatId).length;
  c.socket.emit('ws', makeEnvelope(WsType.TypingUpdate, { chatId, typing: true }));
  await sleep(400);
  check(
    "a non-member cannot inject typing into someone else's chat",
    typingFrames(b, chatId).length === bBefore,
    `${typingFrames(b, chatId).length} vs ${bBefore}`,
  );

  // ── 3. THE ONE THAT MATTERS: the server expires it by itself ────────────
  //
  // A is still "typing" from §1 and deliberately sends nothing further —
  // standing in for a client that crashed, slept or lost its tunnel mid-word.
  console.log(`\n3. the server stops it on its own after ${TypingTimings.serverExpiryMs}ms`);
  console.log('   (A sends nothing — it is standing in for a dead client)');
  await sleep(TypingTimings.serverExpiryMs + 1200);

  const stops = typingFrames(b, chatId).filter(
    (f) => (f.payload as { typing?: boolean })?.typing === false,
  );
  check('B received a server-generated typing: false', stops.length > 0, `${stops.length} stop frames`);

  // ── 4. disconnect clears immediately ────────────────────────────────────
  console.log('\n4. a disconnect clears the state without waiting for expiry');
  a.socket.emit('ws', makeEnvelope(WsType.TypingUpdate, { chatId, typing: true }));
  await sleep(400);
  const beforeDisconnect = typingFrames(b, chatId).filter(
    (f) => (f.payload as { typing?: boolean })?.typing === false,
  ).length;

  a.socket.disconnect();
  // Well under the expiry, so a stop arriving here can only be the disconnect
  // path — not the timer.
  await sleep(1200);
  const afterDisconnect = typingFrames(b, chatId).filter(
    (f) => (f.payload as { typing?: boolean })?.typing === false,
  ).length;
  check(
    'a stop arrived well before the expiry would have fired',
    afterDisconnect > beforeDisconnect,
    `${beforeDisconnect} → ${afterDisconnect}`,
  );

  b.socket.disconnect();
  c.socket.disconnect();

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`);
  await closeDb();
  if (failures > 0) process.exitCode = 1;
}

void main();
