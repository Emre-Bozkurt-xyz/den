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
