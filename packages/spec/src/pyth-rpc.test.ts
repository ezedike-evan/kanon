import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PYTH_FEEDS } from './pyth';
import {
  DEFAULT_MONAD_RPC_URL,
  GET_PRICE_UNSAFE_SELECTOR,
  PYTH_MONAD_ADDRESS,
  decodePriceStruct,
  encodeGetPriceUnsafe,
  fetchPythOnChain,
} from './pyth-rpc';

const BTC = PYTH_FEEDS['BTC/USD']!;
const ETH = PYTH_FEEDS['ETH/USD']!;

// Vectors produced with viem's ABI encoder (see the task notes), pinned here so
// the hand-written codec is checked against an independent implementation.
const BTC_CALLDATA = '0x96834ad3e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const RET_BTC =
  '0x00000000000000000000000000000000000000000000000000000638d952888000000000000000000000000000000000000000000000000000000000004e2d80fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff80000000000000000000000000000000000000000000000000000000068e77800';
const RET_NEGATIVE =
  '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb0000000000000000000000000000000000000000000000000000000000000001fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff80000000000000000000000000000000000000000000000000000000068e77800';
const RET_MAX_INT64 =
  '0x0000000000000000000000000000000000000000000000007fffffffffffffff000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001';

const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0');
const struct = (p: bigint, c: bigint, e: bigint, t: bigint) => `0x${word(p)}${word(c)}${word(e)}${word(t)}`;

describe('encodeGetPriceUnsafe', () => {
  it('is the selector plus the feed id, matching the reference encoding', () => {
    expect(GET_PRICE_UNSAFE_SELECTOR).toBe('0x96834ad3');
    expect(encodeGetPriceUnsafe(BTC)).toBe(BTC_CALLDATA);
  });

  it('accepts a bare or upper-case id and rejects a malformed one', () => {
    expect(encodeGetPriceUnsafe(BTC.slice(2).toUpperCase())).toBe(BTC_CALLDATA);
    expect(() => encodeGetPriceUnsafe('0x1234')).toThrow();
  });
});

describe('decodePriceStruct', () => {
  it('decodes the reference vector', () => {
    expect(decodePriceStruct(RET_BTC)).toEqual({
      price: '6841234000000',
      conf: '5123456',
      expo: -8,
      publishTime: 1_760_000_000,
    });
  });

  it('sign-extends a negative price and expo', () => {
    expect(decodePriceStruct(RET_NEGATIVE)).toMatchObject({ price: '-5', expo: -8 });
  });

  it('reads int64 max and a positive expo exactly', () => {
    expect(decodePriceStruct(RET_MAX_INT64)).toEqual({
      price: '9223372036854775807',
      conf: '0',
      expo: 3,
      publishTime: 1,
    });
  });

  it('rejects wrong length, non-hex, and values outside their declared width', () => {
    expect(() => decodePriceStruct('0x')).toThrow(/4 words/);
    expect(() => decodePriceStruct(`${RET_BTC}00`)).toThrow(/4 words/);
    expect(() => decodePriceStruct('nothex')).toThrow(/hex/);
    expect(() => decodePriceStruct(struct(1n << 63n, 0n, -8n, 1n))).toThrow(RangeError);
    expect(() => decodePriceStruct(struct(1n, 1n << 64n, -8n, 1n))).toThrow(RangeError);
    expect(() => decodePriceStruct(struct(1n, 0n, 1n << 31n, 1n))).toThrow(RangeError);
    expect(() => decodePriceStruct(struct(1n, 0n, -8n, 1n << 60n))).toThrow(RangeError);
  });
});

it('uses the Pyth address in PythMonad.sol', () => {
  const sol = readFileSync(new URL('../../contracts/script/PythMonad.sol', import.meta.url), 'utf8');
  expect(sol).toContain(PYTH_MONAD_ADDRESS);
});

/** A fake JSON-RPC node: answers each eth_call by the feed id in its calldata. */
function rpcNode(byFeed: Record<string, string | { error: string }>) {
  const calls: { url: string; body: any }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    const data: string = body.params[0].data;
    const feed = `0x${data.slice(10)}`;
    const answer = byFeed[feed];
    if (answer === undefined) return new Response('nope', { status: 500 });
    if (typeof answer !== 'string') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: answer.error } }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer }));
  });
  return { fetchFn: fn as unknown as typeof fetch, calls, fn };
}

const two = [
  { symbol: 'BTC/USD', feedId: BTC },
  { symbol: 'ETH/USD', feedId: ETH },
];

describe('fetchPythOnChain', () => {
  it('posts eth_call to the Pyth contract on the default Monad RPC and returns exact updates', async () => {
    const node = rpcNode({
      [BTC]: RET_BTC,
      [ETH]: struct(350_012_000_000n, 1n, -8n, 1_760_000_001n),
    });
    const { updates, skipped } = await fetchPythOnChain(node.fetchFn, {}, two);

    expect(skipped).toEqual([]);
    expect(updates).toEqual([
      { asset: 'BTC/USD', feedId: BTC, price: { atoms: '6841234000000', decimals: 8 }, publishTime: 1_760_000_000 },
      { asset: 'ETH/USD', feedId: ETH, price: { atoms: '350012000000', decimals: 8 }, publishTime: 1_760_000_001 },
    ]);
    expect(node.calls).toHaveLength(2);
    for (const c of node.calls) {
      expect(c.url).toBe(DEFAULT_MONAD_RPC_URL);
      expect(c.body).toMatchObject({ jsonrpc: '2.0', method: 'eth_call' });
      expect(c.body.params[0].to).toBe(PYTH_MONAD_ADDRESS);
      expect(c.body.params[1]).toBe('latest');
    }
    expect(node.calls[0]!.body.params[0].data).toBe(BTC_CALLDATA);
  });

  it('honours a custom RPC url and contract address', async () => {
    const node = rpcNode({ [BTC]: RET_BTC });
    const custom = '0x1111111111111111111111111111111111111111';
    await fetchPythOnChain(node.fetchFn, { rpcUrl: 'https://rpc.example', address: custom }, [two[0]!]);
    expect(node.calls[0]!.url).toBe('https://rpc.example');
    expect(node.calls[0]!.body.params[0].to).toBe(custom);
  });

  it('skips a feed that reverts or is unusable without dropping the others', async () => {
    const node = rpcNode({
      [BTC]: RET_BTC,
      [ETH]: { error: 'execution reverted: PriceFeedNotFound' },
    });
    const { updates, skipped } = await fetchPythOnChain(node.fetchFn, {}, two);
    expect(updates.map((u) => u.asset)).toEqual(['BTC/USD']);
    expect(skipped).toEqual([{ id: ETH, reason: expect.stringContaining('PriceFeedNotFound') }]);
  });

  it('skips a never-updated feed and a non-positive price', async () => {
    const node = rpcNode({
      [BTC]: struct(0n, 0n, -8n, 0n),
      [ETH]: struct(-5n, 0n, -8n, 5n),
      [PYTH_FEEDS['SOL/USD']!]: RET_BTC,
    });
    const { updates, skipped } = await fetchPythOnChain(node.fetchFn, {}, [
      ...two,
      { symbol: 'SOL/USD', feedId: PYTH_FEEDS['SOL/USD']! },
    ]);
    expect(updates.map((u) => u.asset)).toEqual(['SOL/USD']);
    expect(skipped.map((s) => s.reason)).toEqual(['feed has never been updated', 'non-positive price']);
  });

  it('throws when nothing could be read, so a dead RPC is loud', async () => {
    const node = rpcNode({});
    await expect(fetchPythOnChain(node.fetchFn, {}, two)).rejects.toThrow(/no price could be read/);
  });

  it('passes an identical publishTime through unchanged, for the caller to dedupe', async () => {
    const node = rpcNode({ [BTC]: RET_BTC });
    const a = await fetchPythOnChain(node.fetchFn, {}, [two[0]!]);
    const b = await fetchPythOnChain(node.fetchFn, {}, [two[0]!]);
    expect(b.updates[0]!.publishTime).toBe(a.updates[0]!.publishTime);
  });
});
