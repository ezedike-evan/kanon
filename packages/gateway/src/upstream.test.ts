import { silentLogger } from './log';
import { FakeVenue } from './test-helpers';
import { UpstreamPool, type UpstreamOptions } from './upstream';

const CHAIN = 10143;
const HEARTBEAT = `heartbeat@${CHAIN}`;

function setup(overrides: Partial<UpstreamOptions> = {}) {
  const venue = new FakeVenue();
  const frames: Array<{ stream: string; frame: Record<string, unknown> }> = [];
  const rejected: Array<{ stream: string; code: number }> = [];
  const pool = new UpstreamPool({
    url: 'wss://venue.test/ws',
    chainId: CHAIN,
    socketFactory: venue.factory,
    log: silentLogger,
    onFrame: (stream, frame) => frames.push({ stream, frame }),
    onRejected: (stream, code) => rejected.push({ stream, code }),
    ...overrides,
  });
  return { venue, pool, frames, rejected };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('subscribing', () => {
  it('asks for its heartbeat and every wanted stream in one request when the socket opens', () => {
    const { venue, pool } = setup();
    pool.start();
    pool.want('market-state@10143');
    pool.want('candles@16*900');
    expect(venue.sockets).toHaveLength(1);
    expect(venue.last.sent).toHaveLength(0);

    venue.last.open();
    expect(venue.last.sent).toHaveLength(1);
    expect(venue.last.subscribed()).toEqual(['candles@16*900', HEARTBEAT, 'market-state@10143']);
  });

  it('batches streams wanted together into one request', () => {
    const { venue, pool } = setup();
    pool.start();
    venue.last.open();
    pool.want('trades@16');
    pool.want('order-book@16');
    vi.advanceTimersByTime(30);
    expect(venue.last.sent).toHaveLength(2);
    expect(venue.last.sent[1]!.subs).toEqual([
      { stream: 'trades@16', subscribe: true },
      { stream: 'order-book@16', subscribe: true },
    ]);
  });

  it('unsubscribes a stream no longer wanted, and sends nothing for one wanted and dropped in the same breath', () => {
    const { venue, pool } = setup();
    pool.start();
    venue.last.open();
    pool.want('trades@16');
    vi.advanceTimersByTime(30);
    pool.unwant('trades@16');
    pool.want('trades@32');
    pool.unwant('trades@32');
    vi.advanceTimersByTime(30);
    expect(venue.last.sent[2]!.subs).toEqual([{ stream: 'trades@16', subscribe: false }]);
    expect(venue.last.subscribed()).toEqual([HEARTBEAT]);
  });

  it('holds requests back at the per-minute budget and sends them once it frees', () => {
    // No frames arrive in this test, so the stall watchdog is set out of the way.
    const { venue, pool } = setup({ maxRequestsPerMinute: 2, stallMs: 600_000 });
    pool.start();
    venue.last.open(); // request 1
    pool.want('trades@16');
    vi.advanceTimersByTime(30); // request 2
    pool.want('trades@32');
    pool.want('trades@48');
    vi.advanceTimersByTime(59_000);
    expect(venue.last.sent).toHaveLength(2);

    vi.advanceTimersByTime(1_100);
    expect(venue.last.sent).toHaveLength(3);
    expect(venue.last.sent[2]!.subs.map((s) => s.stream)).toEqual(['trades@32', 'trades@48']);
  });
});

describe('routing frames', () => {
  it('relays a per-market frame to the stream its id was acknowledged for', () => {
    const { venue, pool, frames } = setup();
    pool.start();
    pool.want('candles@16*900');
    venue.last.open();
    venue.last.ack([{ stream: 'candles@16*900', sid: 300001603 }]);
    venue.last.frame({ mt: 11, sid: 300001603, r: 900, d: [] });
    expect(frames).toEqual([{ stream: 'candles@16*900', frame: { mt: 11, sid: 300001603, r: 900, d: [] } }]);
  });

  it('routes chain-wide frames by type, because the venue acknowledges funding with the market-state id', () => {
    const { venue, pool, frames } = setup();
    pool.start();
    pool.want('market-state@10143');
    pool.want('funding@10143');
    venue.last.open();
    // Exactly what Perpl answered on 2026-10-09: both streams acknowledged as 3000.
    venue.last.ack([
      { stream: 'market-state@10143', sid: 3000 },
      { stream: 'funding@10143', sid: 3000 },
    ]);
    venue.last.frame({ mt: 9, sid: 3000, d: { '16': { mrk: 1 } } });
    venue.last.frame({ mt: 10, sid: 4000, d: { '16': { rate: 40 } } });
    expect(frames.map((f) => [f.stream, f.frame.mt])).toEqual([
      ['market-state@10143', 9],
      ['funding@10143', 10],
    ]);
  });

  it('drops a frame whose type does not match the stream its id belongs to', () => {
    const { venue, pool, frames } = setup();
    pool.start();
    pool.want('trades@16');
    venue.last.open();
    venue.last.ack([{ stream: 'trades@16', sid: 2000016 }]);
    venue.last.frame({ mt: 15, sid: 2000016, bid: [], ask: [] });
    venue.last.frame({ mt: 17, sid: 999, d: [] });
    venue.last.frame({ mt: 9, sid: 3000, d: {} }); // market-state was never asked for
    expect(frames).toEqual([]);
  });

  it('tells the owner when the venue refuses a stream, and frees its place', () => {
    const { venue, pool, rejected } = setup({ maxSubsPerConnection: 2, maxConnections: 1 });
    pool.start();
    expect(pool.want('trades@999')).toBe(true);
    expect(pool.want('trades@16')).toBe(false);
    venue.last.open();
    venue.last.ack([{ stream: 'trades@999', code: 404, error: 'unknown stream' }]);
    expect(rejected).toEqual([{ stream: 'trades@999', code: 404 }]);
    expect(pool.want('trades@16')).toBe(true);
  });
});

describe('connections', () => {
  it('opens another connection only when the first is full, and refuses past the limit', () => {
    // 3 subscriptions per connection, one of which is its own heartbeat.
    const { venue, pool } = setup({ maxSubsPerConnection: 3, maxConnections: 2 });
    pool.start();
    expect(pool.want('trades@16')).toBe(true);
    expect(pool.want('trades@32')).toBe(true);
    expect(venue.sockets).toHaveLength(1);
    expect(pool.want('trades@48')).toBe(true);
    expect(venue.sockets).toHaveLength(2);
    expect(pool.want('trades@64')).toBe(true);
    expect(pool.want('trades@256')).toBe(false);

    venue.sockets[1]!.open();
    expect(venue.sockets[1]!.subscribed()).toEqual([HEARTBEAT, 'trades@48', 'trades@64']);
  });

  it('closes an extra connection once it carries nothing, but never the first', () => {
    const { venue, pool } = setup({ maxSubsPerConnection: 2, maxConnections: 2, stallMs: 600_000 });
    pool.start();
    pool.want('trades@16');
    pool.want('trades@32');
    const [first, second] = venue.sockets;
    first!.open();
    second!.open();
    pool.unwant('trades@32');
    expect(second!.gone).toBe(true);
    pool.unwant('trades@16');
    expect(first!.gone).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(venue.sockets).toHaveLength(2);
  });

  it('relays the heartbeat from the first connection only', () => {
    const { venue, pool, frames } = setup({ maxSubsPerConnection: 2, maxConnections: 2 });
    pool.start();
    pool.want('trades@16');
    pool.want('trades@32');
    for (const socket of venue.sockets) socket.open();
    venue.sockets[0]!.frame({ mt: 100, sid: 5000, h: 1 });
    venue.sockets[1]!.frame({ mt: 100, sid: 5000, h: 1 });
    expect(frames).toHaveLength(1);
  });

  it('reconnects after a drop and asks for everything again', () => {
    const { venue, pool, frames } = setup();
    pool.start();
    pool.want('candles@16*900');
    venue.last.open();
    venue.last.ack([{ stream: 'candles@16*900', sid: 300001603 }]);
    venue.last.drop(1006, '');

    vi.advanceTimersByTime(20_000);
    expect(venue.sockets).toHaveLength(2);
    venue.last.open();
    expect(venue.last.subscribed()).toEqual(['candles@16*900', HEARTBEAT]);

    // Ids from the old connection mean nothing on the new one until it acknowledges.
    venue.last.frame({ mt: 12, sid: 300001603, d: [] });
    expect(frames).toEqual([]);
    venue.last.ack([{ stream: 'candles@16*900', sid: 300001603 }]);
    venue.last.frame({ mt: 12, sid: 300001603, d: [] });
    expect(frames).toHaveLength(1);
  });

  it('waits longer between attempts while the venue keeps refusing', () => {
    const { venue, pool } = setup();
    pool.start();
    venue.last.drop(1006, '');
    vi.advanceTimersByTime(1_300);
    expect(venue.sockets).toHaveLength(2);
    venue.last.drop(1006, '');
    vi.advanceTimersByTime(1_300);
    expect(venue.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1_200);
    expect(venue.sockets).toHaveLength(3);
  });

  it('replaces a connection that has gone silent', () => {
    const { venue, pool } = setup({ stallMs: 20_000 });
    pool.start();
    venue.last.open();
    vi.advanceTimersByTime(15_000);
    venue.last.frame({ mt: 100, sid: 5000, h: 1 });
    vi.advanceTimersByTime(15_000);
    expect(venue.sockets[0]!.gone).toBe(false);
    expect(pool.healthy()).toBe(true);

    vi.advanceTimersByTime(11_000);
    expect(venue.sockets[0]!.gone).toBe(true);
    expect(pool.healthy()).toBe(false);
  });

  it('sends pongs unprompted once the venue has dropped it for a late pong', () => {
    const { venue, pool } = setup();
    pool.start();
    venue.last.open();
    vi.advanceTimersByTime(5_000);
    expect(venue.last.pongs).toBe(0);

    venue.last.drop(1008, 'ping timeout');
    vi.advanceTimersByTime(20_000);
    venue.last.open();
    vi.advanceTimersByTime(2_000);
    expect(venue.last.pongs).toBe(5);

    // And stops when that connection ends.
    const before = venue.last.pongs;
    venue.last.drop(1006, '');
    vi.advanceTimersByTime(300);
    expect(venue.sockets[1]!.pongs).toBe(before);
  });

  it('stops everything on close', () => {
    const { venue, pool } = setup();
    pool.start();
    venue.last.open();
    pool.close();
    expect(venue.last.gone).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(venue.sockets).toHaveLength(1);
  });
});
