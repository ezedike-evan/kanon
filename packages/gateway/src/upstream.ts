/**
 * The gateway's side of the Perpl market-data socket.
 *
 * Perpl allows 16 subscriptions and 10 requests a minute per connection, and
 * refuses browser connections from any origin but its own. So the gateway holds
 * the connection: however many people are watching, the venue sees one client.
 * A second and third connection are opened only when more distinct streams are
 * wanted than one connection can carry.
 *
 * Each connection reconciles: it knows which streams are wanted and which it
 * has asked the venue for, and sends the difference as one batched request when
 * the request budget allows. A reconnect starts from nothing asked, so the same
 * reconciliation resubscribes everything.
 *
 * Frames are routed by what they are, not only by the subscription id the venue
 * acknowledged. Measured 2026-10-09: the ack for `funding@<chain>` carries the
 * id of `market-state@<chain>` (3000) while funding frames arrive on 4000, so
 * trusting the ack would relay prices as funding. A chain-wide frame is routed
 * by its type alone; a per-market frame by its acknowledged id, and only if its
 * type matches the stream that id was given for.
 */

import type { Logger } from './log';
import { MT, isChainKind, kindOfFrame } from './streams';

/** The few socket operations the pool needs. `ws-socket.ts` adapts the real one. */
export interface UpstreamSocket {
  send(data: string): void;
  /** Sends a protocol-level pong frame that no ping asked for. */
  pong(): void;
  /** Drops the connection now. `onClose` still fires. */
  terminate(): void;
}

export interface UpstreamSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

export type SocketFactory = (url: string, handlers: UpstreamSocketHandlers) => UpstreamSocket;

export interface UpstreamOptions {
  url: string;
  chainId: number;
  socketFactory: SocketFactory;
  log: Logger;
  onFrame(stream: string, frame: Record<string, unknown>, raw: string): void;
  /** The venue refused a stream (unknown name, or its own cap). It is no longer wanted. */
  onRejected(stream: string, code: number, error: string): void;
  maxConnections?: number;
  /** Venue limit per connection. */
  maxSubsPerConnection?: number;
  /** Kept under the venue's 10 so a miscount on either side cannot close the socket. */
  maxRequestsPerMinute?: number;
  /** A connection with no frame for this long is treated as dead. */
  stallMs?: number;
}

const COALESCE_MS = 25;
const CONNECT_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** A connection that lasted this long is healthy; one that did not backs off further. */
const STABLE_MS = 30_000;
const WATCHDOG_MS = 5_000;
/**
 * The venue pings about every five seconds and closes with 1008 "ping timeout"
 * unless a pong reaches it within about one. On a link with a round trip near
 * a second, the automatic reply cannot make that. The venue accepts any pong in
 * the window (measured 2026-10-09), so once a connection has been lost this
 * way the pool sends pongs unprompted at this interval, which always lands one
 * inside the window whatever the latency.
 */
const UNPROMPTED_PONG_MS = 400;

class Conn {
  /** Streams assigned to this connection by the pool. */
  readonly wanted = new Set<string>();
  /** Streams the venue has been asked for on the current socket. */
  private readonly asked = new Set<string>();
  private readonly sidToStream = new Map<number, string>();
  private socket: UpstreamSocket | null = null;
  private open = false;
  private closed = false;
  private sendTimes: number[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private connectStartedAt = 0;
  private openedAt = 0;
  lastFrameAt = 0;

  constructor(
    private readonly pool: UpstreamPool,
    readonly id: number,
  ) {
    this.connect();
  }

  get isOpen(): boolean {
    return this.open;
  }

  private connect(): void {
    if (this.closed) return;
    this.connectStartedAt = Date.now();
    this.socket = this.pool.opts.socketFactory(this.pool.opts.url, {
      onOpen: () => {
        this.open = true;
        this.openedAt = Date.now();
        this.lastFrameAt = this.openedAt;
        this.sendTimes = [];
        this.pool.opts.log({ level: 'info', event: 'upstream_open', conn: this.id });
        if (this.pool.pongUnprompted) {
          this.pongTimer = setInterval(() => this.socket?.pong(), UNPROMPTED_PONG_MS);
        }
        this.flush();
      },
      onMessage: (data) => this.receive(data),
      onClose: (code, reason) => this.handleClose(code, reason),
    });
  }

  private handleClose(code: number, reason: string): void {
    const wasOpen = this.open;
    this.open = false;
    this.socket = null;
    this.asked.clear();
    this.sidToStream.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pongTimer) clearInterval(this.pongTimer);
    this.pongTimer = null;
    if (this.closed) return;
    if (code === 1008 && /ping timeout/i.test(reason) && !this.pool.pongUnprompted) {
      this.pool.pongUnprompted = true;
      this.pool.opts.log({ level: 'warn', event: 'upstream_slow_link', conn: this.id, pongEveryMs: UNPROMPTED_PONG_MS });
    }
    this.failures = wasOpen && Date.now() - this.openedAt >= STABLE_MS ? 0 : this.failures + 1;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.failures);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.pool.opts.log({ level: 'warn', event: 'upstream_closed', conn: this.id, code, reason, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Called by the watchdog. A silent or never-opening connection is replaced. */
  check(now: number, stallMs: number): void {
    if (!this.socket) return;
    const stalled = this.open ? now - this.lastFrameAt > stallMs : now - this.connectStartedAt > CONNECT_TIMEOUT_MS;
    if (!stalled) return;
    this.pool.opts.log({ level: 'warn', event: 'upstream_stalled', conn: this.id, open: this.open });
    this.socket.terminate();
  }

  scheduleFlush(delayMs = COALESCE_MS): void {
    if (this.flushTimer || !this.open) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
  }

  /** Every stream this connection should be carrying, including its own liveness stream. */
  private desired(): Set<string> {
    return new Set([this.pool.heartbeat, ...this.wanted]);
  }

  private flush(): void {
    if (!this.open || !this.socket) return;
    const desired = this.desired();
    const subs: Array<{ stream: string; subscribe: boolean }> = [];
    for (const stream of desired) if (!this.asked.has(stream)) subs.push({ stream, subscribe: true });
    for (const stream of this.asked) if (!desired.has(stream)) subs.push({ stream, subscribe: false });
    if (subs.length === 0) return;

    const now = Date.now();
    const limit = this.pool.maxRequestsPerMinute;
    this.sendTimes = this.sendTimes.filter((t) => now - t < 60_000);
    if (this.sendTimes.length >= limit) {
      this.scheduleFlush(this.sendTimes[0]! + 60_000 - now + 50);
      return;
    }
    this.sendTimes.push(now);
    for (const s of subs) {
      if (s.subscribe) {
        this.asked.add(s.stream);
      } else {
        this.asked.delete(s.stream);
        for (const [sid, stream] of this.sidToStream) if (stream === s.stream) this.sidToStream.delete(sid);
      }
    }
    this.socket.send(JSON.stringify({ mt: MT.subscribe, subs }));
  }

  private receive(raw: string): void {
    this.lastFrameAt = Date.now();
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const f = frame as Record<string, unknown>;
    if (f.mt === MT.subscribeAck) {
      this.acknowledge(f);
      return;
    }
    const kind = kindOfFrame(f.mt);
    if (kind === undefined) return;
    let stream: string | undefined;
    if (isChainKind(kind)) {
      stream = `${kind}@${this.pool.opts.chainId}`;
      if (!this.asked.has(stream)) return;
    } else {
      stream = typeof f.sid === 'number' ? this.sidToStream.get(f.sid) : undefined;
      if (stream === undefined || !stream.startsWith(`${kind}@`)) return;
    }
    // Every connection carries the heartbeat for liveness; only the first relays it.
    if (stream === this.pool.heartbeat && this.id !== 0) return;
    this.pool.opts.onFrame(stream, f, raw);
  }

  private acknowledge(frame: Record<string, unknown>): void {
    if (!Array.isArray(frame.subs)) return;
    for (const entry of frame.subs as Array<Record<string, unknown>>) {
      const stream = entry?.stream;
      if (typeof stream !== 'string') continue;
      const status = entry.status as { code?: unknown; error?: unknown } | undefined;
      const code = typeof status?.code === 'number' ? status.code : 0;
      if (code === 0) {
        // Only per-market streams are looked up by id; see the note at the top of the file.
        const perMarket = /^(candles|order-book|trades)@/.test(stream);
        if (perMarket && typeof entry.sid === 'number' && this.asked.has(stream)) {
          this.sidToStream.set(entry.sid, stream);
        }
        continue;
      }
      this.asked.delete(stream);
      const error = typeof status?.error === 'string' ? status.error : 'refused by venue';
      this.pool.opts.log({ level: 'warn', event: 'upstream_rejected', conn: this.id, stream, code, error });
      if (this.wanted.delete(stream)) this.pool.released(stream, { code, error });
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pongTimer) clearInterval(this.pongTimer);
    this.socket?.terminate();
  }
}

export interface UpstreamStatus {
  connections: Array<{ id: number; open: boolean; streams: number; msSinceFrame: number | null }>;
}

export class UpstreamPool {
  readonly heartbeat: string;
  readonly maxRequestsPerMinute: number;
  /** Set once the venue has dropped a connection for a late pong. See `UNPROMPTED_PONG_MS`. */
  pongUnprompted = false;
  private readonly maxConnections: number;
  /** Streams a connection can carry besides its own heartbeat. */
  private readonly capacity: number;
  private readonly stallMs: number;
  private conns: Conn[] = [];
  private readonly byStream = new Map<string, Conn>();
  private nextId = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(readonly opts: UpstreamOptions) {
    this.heartbeat = `heartbeat@${opts.chainId}`;
    this.maxConnections = opts.maxConnections ?? 3;
    this.capacity = (opts.maxSubsPerConnection ?? 16) - 1;
    this.maxRequestsPerMinute = opts.maxRequestsPerMinute ?? 8;
    this.stallMs = opts.stallMs ?? 20_000;
  }

  /** Opens the first connection, which stays up for the life of the process, and starts the watchdog. */
  start(): void {
    if (this.conns.length === 0) this.conns.push(new Conn(this, this.nextId++));
    this.watchdog ??= setInterval(() => {
      const now = Date.now();
      for (const conn of this.conns) conn.check(now, this.stallMs);
    }, WATCHDOG_MS);
  }

  /**
   * Asks for a stream to be carried. False means every connection is full and
   * no more may be opened; the caller frees a stream it no longer needs and
   * tries again.
   */
  want(stream: string): boolean {
    if (stream === this.heartbeat || this.byStream.has(stream)) return true;
    let conn = this.conns.find((c) => c.wanted.size < this.capacity);
    if (!conn) {
      if (this.conns.length >= this.maxConnections) return false;
      conn = new Conn(this, this.nextId++);
      this.conns.push(conn);
    }
    conn.wanted.add(stream);
    this.byStream.set(stream, conn);
    conn.scheduleFlush();
    return true;
  }

  unwant(stream: string): void {
    const conn = this.byStream.get(stream);
    if (!conn) return;
    this.byStream.delete(stream);
    conn.wanted.delete(stream);
    // An extra connection with nothing left to carry is closed rather than kept idle.
    if (conn.wanted.size === 0 && conn !== this.conns[0]) {
      conn.dispose();
      this.conns = this.conns.filter((c) => c !== conn);
    } else {
      conn.scheduleFlush();
    }
  }

  /** A connection gave a stream up because the venue refused it. */
  released(stream: string, reason: { code: number; error: string }): void {
    this.byStream.delete(stream);
    this.opts.onRejected(stream, reason.code, reason.error);
  }

  status(): UpstreamStatus {
    const now = Date.now();
    return {
      connections: this.conns.map((c) => ({
        id: c.id,
        open: c.isOpen,
        streams: c.wanted.size,
        msSinceFrame: c.isOpen ? now - c.lastFrameAt : null,
      })),
    };
  }

  /** True while the first connection is open and has heard from the venue recently. */
  healthy(): boolean {
    const first = this.conns[0];
    return first !== undefined && first.isOpen && Date.now() - first.lastFrameAt <= this.stallMs;
  }

  close(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const conn of this.conns) conn.dispose();
    this.conns = [];
    this.byStream.clear();
  }
}
