import type { FeedFetch, FeedSocket } from './market-feed';

/**
 * A stand-in gateway for tests: REST answers computed from a made-up venue,
 * and sockets the test opens, feeds and drops by hand.
 *
 * The venue here has a candle for every interval up to the clock, as the real
 * one does, with prices that follow from the open time, so a test can say what
 * any candle should be without a table.
 */

export const BASE = 'http://gateway.test';

/** Testnet's shape: the symbol carries the base. */
export const CONTEXT = {
  chain: { chain_id: 10143 },
  markets: [
    { id: 16, symbol: 'BTC', name: 'BTC Perp', config: { price_decimals: 1, size_decimals: 5, is_open: true } },
    { id: 32, symbol: 'ETH', name: 'ETH Perp', config: { price_decimals: 2, size_decimals: 3, is_open: true } },
  ],
};

export interface WireCandle {
  t: number;
  o: number;
  c: number;
  h: number;
  l: number;
  v: string;
  n: number;
}

/** The venue's candle opening at `t`. `lift` moves its close, as a trade would. */
export function venueCandle(t: number, stepMs: number, lift = 0): WireCandle {
  const p = 800_000 + ((t / stepMs) % 10_000);
  return { t, o: p, c: p + 1 + lift, h: p + 5 + lift, l: p - 5, v: '1000', n: 3 };
}

/** Every venue candle that opens in `[from, to]` and has opened by `now`. */
export function venueRange(from: number, to: number, stepMs: number, now: number): WireCandle[] {
  const out: WireCandle[] = [];
  for (let t = from; t <= to && t <= now; t += stepMs) out.push(venueCandle(t, stepMs));
  return out;
}

type Answer = { status: number; body: unknown };

export function createFakeRest(now: () => number) {
  const paths: string[] = [];
  const waiting: Array<() => void> = [];
  let held: ((path: string) => boolean) | null = null;
  let override: ((path: string) => Answer | undefined) | null = null;

  const answer = (path: string): Answer => {
    const forced = override?.(path);
    if (forced) return forced;
    if (path === '/v1/pub/context') return { status: 200, body: CONTEXT };
    const m = /^\/v1\/market-data\/(\d+)\/candles\/(\d+)\/(\d+)-(\d+)$/.exec(path);
    if (!m) return { status: 404, body: { error: 'not found' } };
    const stepMs = Number(m[2]) * 1000;
    return { status: 200, body: { mt: 12, r: Number(m[2]), d: venueRange(Number(m[3]), Number(m[4]), stepMs, now()) } };
  };

  const fetch: FeedFetch = (url) =>
    new Promise((resolve) => {
      const path = url.slice(BASE.length);
      paths.push(path);
      const respond = () => {
        const { status, body } = answer(path);
        resolve({ status, json: async () => body });
      };
      if (held?.(path)) waiting.push(respond);
      else respond();
    });

  return {
    fetch,
    /** Every path asked for, in order. */
    paths,
    candlePaths: () => paths.filter((p) => p.includes('/candles/')),
    /** Answers to matching paths (every path, by default) stop arriving until `release`. */
    hold(match: (path: string) => boolean = () => true) {
      held = match;
    },
    release() {
      held = null;
      for (const respond of waiting.splice(0)) respond();
    },
    /** Replaces the answer for any path the function returns one for. */
    respondWith(fn: ((path: string) => Answer | undefined) | null) {
      override = fn;
    },
  };
}

export class FakeSocket implements FeedSocket {
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  /** Frames the client sent, parsed. */
  readonly sent: any[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }

  // The test's side of the connection.
  open(): void {
    this.onopen?.({});
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The connection drops, as a network would drop it. */
  lose(): void {
    this.onclose?.({ code: 1006 });
  }
  /** Every subscription change sent, flattened: `[stream, subscribe]`. */
  subs(): Array<[string, boolean]> {
    return this.sent
      .filter((f) => f.mt === 5)
      .flatMap((f) => (f.subs as Array<{ stream: string; subscribe: boolean }>).map((s) => [s.stream, s.subscribe] as [string, boolean]));
  }
  /** Acknowledges everything asked for so far, as the gateway does. */
  ack(): void {
    this.receive({ mt: 6, subs: this.subs().map(([stream]) => ({ stream, status: { code: 0 } })) });
  }
}

export function createFakeSockets() {
  const all: FakeSocket[] = [];
  class Socket extends FakeSocket {
    constructor(url: string) {
      super(url);
      all.push(this);
    }
  }
  return {
    Socket,
    all,
    /** The newest connection. */
    get last(): FakeSocket {
      const socket = all[all.length - 1];
      if (!socket) throw new Error('no socket was opened');
      return socket;
    },
  };
}
