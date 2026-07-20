import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { connectSocket, ping } from '../lib/socket';

/** Stage 0 sanity panel: proves the socket connects and the WsEnvelope round-trips. */
export function WsProbe() {
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState<number | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    return () => {
      socket.close();
    };
  }, []);

  async function onPing() {
    if (socketRef.current?.connected) setRtt(await ping(socketRef.current));
  }

  return (
    <section className="rounded-sm border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
      <h2 className="text-base font-semibold">WebSocket probe</h2>
      <div className="mt-2 flex items-center gap-3 text-sm">
        <span
          className={
            'inline-flex items-center gap-1.5 ' +
            (connected ? 'text-green-600 dark:text-green-400' : 'text-neutral-400')
          }
        >
          <span
            className={'h-2 w-2 rounded-pill ' + (connected ? 'bg-green-500' : 'bg-neutral-400')}
          />
          {connected ? 'connected' : 'disconnected'}
        </span>
        <button
          onClick={onPing}
          disabled={!connected}
          className="rounded-sm border border-black/10 px-3 py-1 text-sm dark:border-white/15 disabled:opacity-40"
        >
          Ping
        </button>
        {rtt !== null && <span className="text-neutral-500">{rtt} ms round-trip</span>}
      </div>
    </section>
  );
}
