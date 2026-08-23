import { io, type Socket } from 'socket.io-client';
import { WsType, makeEnvelope, type WsEnvelope } from '@den/shared';

/**
 * Thin socket.io wrapper. Every frame rides the single 'ws' event as a
 * `WsEnvelope` (hard invariant 4). Stage 0 only exercises hello + ping/pong;
 * chat rooms + cookie-auth land in Stage 2.
 */
export function connectSocket(): Socket {
  // Same-origin; Caddy proxies /socket.io in prod, Vite proxies it in dev.
  const socket = io({ withCredentials: true, transports: ['websocket'] });
  return socket;
}

export function sendEnvelope(socket: Socket, frame: WsEnvelope): void {
  socket.emit('ws', frame);
}

/**
 * How long a resume-time liveness probe waits for a `pong` before declaring
 * the socket dead. Generous enough for a phone whose radio is still waking up,
 * short enough that the user isn't staring at a stale chat while we wait.
 */
const LIVENESS_TIMEOUT_MS = 2_500;

/**
 * Make sure the socket is *genuinely* connected, kicking it if it isn't.
 * Fire-and-forget: the reconnect (if one is needed) reports itself through the
 * socket's own `connect` event, which is already where resync hangs off.
 *
 * `socket.connected` cannot be trusted after the app has been backgrounded.
 * engine.io detects a dead peer with *timers*, and a frozen page's timers do
 * not run — so a socket whose TCP connection the phone tore down while the
 * screen was off still reports `connected: true` on resume, and keeps
 * reporting it until the missed heartbeat deadline finally elapses (up to
 * `pingInterval + pingTimeout`, ~45s by default) and only *then* starts
 * reconnecting with backoff. For most of a minute the app believes it has a
 * live feed and silently receives nothing (owner report, 2026-08-23).
 *
 * So: ask, don't trust. A `ping` that goes unanswered means the socket is a
 * zombie, and an explicit `disconnect()` + `connect()` restarts the handshake
 * immediately instead of waiting out a deadline nobody was counting.
 */
export function reviveSocket(socket: Socket): void {
  if (!socket.connected) {
    // Already known-dead: socket.io is likely mid-backoff (up to 5s between
    // attempts). `connect()` on a disconnected socket attempts right now.
    socket.connect();
    return;
  }

  const reqId = crypto.randomUUID();
  let timer = 0;
  const onFrame = (frame: WsEnvelope) => {
    if (frame.type !== WsType.Pong || frame.reqId !== reqId) return;
    clearTimeout(timer);
    socket.off('ws', onFrame);
  };
  timer = window.setTimeout(() => {
    socket.off('ws', onFrame);
    // Only a socket that still *claims* to be connected needs the kick; one
    // that already noticed on its own has its own reconnection loop running.
    if (socket.connected) {
      socket.disconnect();
      socket.connect();
    }
  }, LIVENESS_TIMEOUT_MS);
  socket.on('ws', onFrame);
  sendEnvelope(socket, makeEnvelope(WsType.Ping, {}, reqId));
}

/** Round-trip latency probe used by the Stage 0 WS panel. */
export function ping(socket: Socket): Promise<number> {
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID();
    const started = performance.now();
    const onFrame = (frame: WsEnvelope) => {
      if (frame.type === WsType.Pong && frame.reqId === reqId) {
        socket.off('ws', onFrame);
        resolve(Math.round(performance.now() - started));
      }
    };
    socket.on('ws', onFrame);
    sendEnvelope(socket, makeEnvelope(WsType.Ping, {}, reqId));
  });
}
