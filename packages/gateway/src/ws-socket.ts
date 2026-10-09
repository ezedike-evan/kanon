import WebSocket from 'ws';
import type { SocketFactory } from './upstream';

const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * The real venue socket. A server-side client sends no Origin header, which is
 * the case Perpl accepts; a browser on another site's origin is refused.
 */
export const wsSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
  let closed = false;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
  };
  ws.on('open', () => handlers.onOpen());
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    handlers.onMessage(text);
  });
  ws.on('close', (code, reason) => close(code, reason.toString('utf8')));
  // A failed handshake reports an error and may never report a close.
  ws.on('error', () => {
    ws.terminate();
    close(1006, 'connection failed');
  });
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    pong() {
      if (ws.readyState === WebSocket.OPEN) ws.pong();
    },
    terminate() {
      ws.terminate();
    },
  };
};
