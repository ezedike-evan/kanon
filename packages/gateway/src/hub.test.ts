import { Hub, type HubClient, type HubOptions } from './hub';
import { silentLogger } from './log';

const CHAIN = 10143;

class Client implements HubClient {
  readonly got: Array<Record<string, unknown>> = [];
  send(text: string): void {
    this.got.push(JSON.parse(text));
  }
  /** The status of each stream in the most recent ack. */
  lastAck(): Record<string, number> {
    const ack = [...this.got].reverse().find((f) => f.mt === 6);
    const subs = (ack?.subs ?? []) as Array<{ stream: string; status: { code: number } }>;
    return Object.fromEntries(subs.map((s) => [s.stream, s.status.code]));
  }
  data(): Array<Record<string, unknown>> {
    return this.got.filter((f) => f.mt !== 6);
  }
}

function setup(overrides: Partial<HubOptions> = {}) {
  const wanted = new Set<string>();
  let capacity = Infinity;
  const source = {
    want: vi.fn((stream: string) => {
      if (wanted.has(stream)) return true;
      if (wanted.size >= capacity) return false;
      wanted.add(stream);
      return true;
    }),
    unwant: vi.fn((stream: string) => void wanted.delete(stream)),
  };
  const hub = new Hub({
    chainId: CHAIN,
    source,
    log: silentLogger,
    isKnownMarket: (id) => id === 16 || id === 32,
    lingerMs: 60_000,
    ...overrides,
  });
  return { hub, source, wanted, setCapacity: (n: number) => (capacity = n) };
}

const subscribe = (...streams: string[]) => streams.map((stream) => ({ stream, subscribe: true }));
const candles = (c: number) => ({ mt: 11, sid: 1, at: { b: 1 }, r: 900, d: [{ t: 0, o: 1, c, h: 1, l: 1, v: '1', n: 1 }] });
const relay = (hub: Hub, stream: string, frame: Record<string, unknown>) => hub.onFrame(stream, frame, JSON.stringify(frame));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('subscribing', () => {
  it('acknowledges, then relays venue frames tagged with the stream name', () => {
    const { hub, source } = setup();
    const a = new Client();
    hub.request(a, subscribe('candles@16*900'));
    expect(a.got).toEqual([{ mt: 6, subs: [{ stream: 'candles@16*900', status: { code: 0 } }] }]);
    expect(source.want).toHaveBeenCalledWith('candles@16*900');

    relay(hub, 'candles@16*900', candles(5));
    expect(a.data()).toEqual([{ stream: 'candles@16*900', ...candles(5) }]);
  });

  it('gives a late joiner the current state at once, after its ack, without asking the venue again', () => {
    const { hub, source } = setup();
    const a = new Client();
    const b = new Client();
    hub.request(a, subscribe('candles@16*900'));
    relay(hub, 'candles@16*900', candles(5));
    relay(hub, 'candles@16*900', { mt: 12, sid: 1, at: { b: 2 }, d: [{ t: 0, o: 1, c: 9, h: 1, l: 1, v: '1', n: 2 }] });

    hub.request(b, subscribe('candles@16*900'));
    expect(source.want).toHaveBeenCalledTimes(1);
    expect(b.got.map((f) => f.mt)).toEqual([6, 11]);
    expect((b.got[1]!.d as Array<{ c: number }>)[0]!.c).toBe(9);
    expect(b.got[1]!.stream).toBe('candles@16*900');
  });

  it('answers each entry of a request on its own', () => {
    const { hub, source } = setup();
    const a = new Client();
    hub.request(a, subscribe('trades@16', 'trades@999', 'gas-stats@10143', 'market-state@143'));
    expect(a.lastAck()).toEqual({ 'trades@16': 0, 'trades@999': 404, 'gas-stats@10143': 404, 'market-state@143': 404 });
    expect(source.want).toHaveBeenCalledTimes(1);
  });

  it('lets the venue judge a market id while the market list is not loaded', () => {
    const { hub, source } = setup({ isKnownMarket: () => null });
    const a = new Client();
    hub.request(a, subscribe('trades@999'));
    expect(a.lastAck()).toEqual({ 'trades@999': 0 });
    expect(source.want).toHaveBeenCalledWith('trades@999');
  });

  it('refuses a request that is not a list of subscriptions', () => {
    const { hub } = setup();
    const a = new Client();
    hub.request(a, 'candles@16*900');
    hub.request(a, []);
    expect(a.got.map((f) => (f.subs as Array<{ status: { code: number } }>)[0]!.status.code)).toEqual([400, 400]);
  });

  it('caps the streams one client may hold', () => {
    const { hub } = setup({ maxSubsPerClient: 2 });
    const a = new Client();
    hub.request(a, subscribe('trades@16', 'trades@32'));
    hub.request(a, subscribe('order-book@16'));
    expect(a.lastAck()).toEqual({ 'order-book@16': 429 });
  });

  it('tells subscribers when the venue refuses a stream, and forgets it', () => {
    const { hub, source } = setup({ isKnownMarket: () => null });
    const a = new Client();
    hub.request(a, subscribe('trades@999'));
    hub.onRejected('trades@999', 404, 'unknown stream');
    expect(a.lastAck()).toEqual({ 'trades@999': 404 });

    relay(hub, 'trades@999', { mt: 17, d: [] });
    expect(a.data()).toEqual([]);
    hub.request(a, subscribe('trades@999'));
    expect(source.want).toHaveBeenCalledTimes(2);
  });
});

describe('leaving', () => {
  it('keeps an unwatched stream subscribed through the linger, then lets it go', () => {
    const { hub, source } = setup();
    const a = new Client();
    hub.request(a, subscribe('trades@16'));
    hub.request(a, [{ stream: 'trades@16', subscribe: false }]);
    expect(a.lastAck()).toEqual({ 'trades@16': 0 });

    relay(hub, 'trades@16', { mt: 17, d: [] });
    expect(a.data()).toEqual([]);
    vi.advanceTimersByTime(59_000);
    expect(source.unwant).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(source.unwant).toHaveBeenCalledWith('trades@16');
  });

  it('serves a returning viewer from memory during the linger', () => {
    const { hub, source } = setup();
    const a = new Client();
    hub.request(a, subscribe('candles@16*900'));
    relay(hub, 'candles@16*900', candles(5));
    hub.remove(a);
    vi.advanceTimersByTime(30_000);

    const b = new Client();
    hub.request(b, subscribe('candles@16*900'));
    expect(b.got.map((f) => f.mt)).toEqual([6, 11]);
    vi.advanceTimersByTime(120_000);
    expect(source.unwant).not.toHaveBeenCalled();
    expect(source.want).toHaveBeenCalledTimes(1);
  });

  it('stops sending to a client that disconnected', () => {
    const { hub } = setup();
    const a = new Client();
    const b = new Client();
    hub.request(a, subscribe('trades@16', 'trades@32'));
    hub.request(b, subscribe('trades@16'));
    hub.remove(a);
    relay(hub, 'trades@16', { mt: 18, d: [] });
    expect(a.data()).toEqual([]);
    expect(b.data()).toHaveLength(1);
    expect(hub.stats()).toEqual({ subscribers: 1, streams: 2, watched: 1 });
  });
});

describe('capacity', () => {
  it('frees the stream unwatched longest when the venue connections are full', () => {
    const { hub, source, setCapacity } = setup();
    const a = new Client();
    hub.request(a, subscribe('trades@16'));
    vi.advanceTimersByTime(1_000);
    hub.request(a, subscribe('trades@32'));
    hub.request(a, [{ stream: 'trades@16', subscribe: false }]);
    vi.advanceTimersByTime(1_000);
    hub.request(a, [{ stream: 'trades@32', subscribe: false }]);
    setCapacity(2);

    hub.request(a, subscribe('order-book@16'));
    expect(a.lastAck()).toEqual({ 'order-book@16': 0 });
    expect(source.unwant).toHaveBeenCalledTimes(1);
    expect(source.unwant).toHaveBeenCalledWith('trades@16');
  });

  it('refuses a new stream when every stream is being watched', () => {
    const { hub, setCapacity } = setup();
    const a = new Client();
    hub.request(a, subscribe('trades@16'));
    setCapacity(1);
    hub.request(a, subscribe('trades@32'));
    expect(a.lastAck()).toEqual({ 'trades@32': 429 });
  });

  it('keeps pinned streams subscribed with nobody watching, and never frees them', () => {
    const { hub, source, setCapacity } = setup({ pinned: ['market-state@10143', 'not-a-stream'] });
    expect(source.want).toHaveBeenCalledWith('market-state@10143');
    relay(hub, 'market-state@10143', { mt: 9, sn: 1, d: { '16': { mrk: 1 } } });

    const a = new Client();
    hub.request(a, subscribe('market-state@10143'));
    expect(a.data()).toEqual([{ stream: 'market-state@10143', mt: 9, sn: 1, d: { '16': { mrk: 1 } } }]);
    hub.remove(a);
    vi.advanceTimersByTime(600_000);
    setCapacity(1);
    hub.request(a, subscribe('trades@16'));
    expect(a.lastAck()).toEqual({ 'trades@16': 429 });
    expect(source.unwant).not.toHaveBeenCalled();
  });
});
