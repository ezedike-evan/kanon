import type { SocketFactory, UpstreamSocket, UpstreamSocketHandlers } from './upstream';

/** One venue connection as the pool sees it, driven by the test. */
export class FakeSocket implements UpstreamSocket {
  /** Every frame the pool sent, parsed. */
  readonly sent: Array<{ mt: number; subs: Array<{ stream: string; subscribe: boolean }> }> = [];
  pongs = 0;
  gone = false;

  constructor(private readonly handlers: UpstreamSocketHandlers) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  pong(): void {
    this.pongs++;
  }
  terminate(): void {
    this.drop(1006, '');
  }

  /** The handshake completed. */
  open(): void {
    this.handlers.onOpen();
  }
  /** The venue sent a frame. */
  frame(frame: Record<string, unknown>): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }
  /** The venue acknowledged streams with the given ids. */
  ack(subs: Array<{ stream: string; sid?: number; code?: number; error?: string }>): void {
    this.frame({
      mt: 6,
      subs: subs.map((s) => ({
        stream: s.stream,
        ...(s.sid === undefined ? {} : { sid: s.sid }),
        status: { code: s.code ?? 0, ...(s.error ? { error: s.error } : {}) },
      })),
    });
  }
  /** The connection ended. */
  drop(code: number, reason: string): void {
    if (this.gone) return;
    this.gone = true;
    this.handlers.onClose(code, reason);
  }

  /** Streams subscribed minus streams unsubscribed, over everything sent. */
  subscribed(): string[] {
    const on = new Set<string>();
    for (const frame of this.sent) for (const s of frame.subs) s.subscribe ? on.add(s.stream) : on.delete(s.stream);
    return [...on].sort();
  }
}

export class FakeVenue {
  readonly sockets: FakeSocket[] = [];
  readonly factory: SocketFactory = (_url, handlers) => {
    const socket = new FakeSocket(handlers);
    this.sockets.push(socket);
    return socket;
  };
  /** The most recently created connection. */
  get last(): FakeSocket {
    const socket = this.sockets[this.sockets.length - 1];
    if (!socket) throw new Error('no connection has been opened');
    return socket;
  }
}
