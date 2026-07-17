/**
 * Realtime layer (socket.io). Stage 0 wires the transport and proves the LOCKED
 * `WsEnvelope` round-trips (hello + ping/pong). Rooms = chat memberships, and
 * cookie-authenticated upgrades, arrive in Stage 2.
 *
 * All traffic uses `WsEnvelope` from @den/shared — no second envelope, ever
 * (hard invariant 4).
 */
import type { Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { WsType, makeEnvelope, isReservedWsType, type WsEnvelope } from '@den/shared';
import { env } from './env.js';

export function attachWs(httpServer: HttpServer): IOServer {
  const io = new IOServer(httpServer, {
    // Same-origin in production; allow the Vite dev origin in dev.
    cors: env.isProd ? undefined : { origin: true, credentials: true },
    pingInterval: 25_000, // proxies kill idle sockets (BACKBONE §8)
    pingTimeout: 20_000,
  });

  io.on('connection', (socket) => {
    socket.emit('ws', makeEnvelope(WsType.Hello, { hello: 'den', socketId: socket.id }));

    // Single inbound channel: every frame is a WsEnvelope on the 'ws' event.
    socket.on('ws', (frame: WsEnvelope) => {
      if (!frame || typeof frame.type !== 'string') return;
      // Guard the reserved call.* prefixes — MVP must never accept them.
      if (isReservedWsType(frame.type)) return;

      switch (frame.type) {
        case WsType.Ping:
          socket.emit('ws', makeEnvelope(WsType.Pong, {}, frame.reqId));
          break;
        default:
          // Unknown types are ignored in Stage 0; real handlers land per-stage.
          break;
      }
    });
  });

  return io;
}
