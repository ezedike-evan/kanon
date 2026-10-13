import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Hex,
} from 'viem';
import { monad } from 'viem/chains';
import { PinError } from './pin';
import { createViemPinClient, registryAbi } from './pin-viem';

const REGISTRY = '0x1234567890abcdef1234567890abcdef12345678' as const;
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const;
const SPEC_HASH = `0x${'ab'.repeat(32)}` as Hex;
const COMMITMENT = `0x${'ef'.repeat(32)}` as Hex;
const SERIES = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9' as const;
const TARGET = { specHash: SPEC_HASH, predicatesCommitment: COMMITMENT, series: SERIES };
const TX = `0x${'cd'.repeat(32)}` as Hex;
const MIN_BOND = 250_000_000_000_000_000n;
const SIGNATURE = `0x${'5a'.repeat(65)}` as Hex;

const TIGHTEN_SIG =
  'tighten(uint256,bytes32,bytes32,address,(uint8,bytes32,uint8,uint256,uint256,uint8,uint8,uint256)[],(uint8,bytes32,uint8,uint256,uint256,uint8,uint8,uint256)[])';

describe('registryAbi', () => {
  // The typed ABI here is hand-written. This pins it to the compiled contract's own ABI,
  // so the two cannot drift: a renamed function or a changed argument fails here.
  const compiled = JSON.parse(
    readFileSync(new URL('../../../contracts/abi/StrategyRegistry.json', import.meta.url), 'utf8'),
  ) as Array<{
    type: string;
    name?: string;
    inputs?: Array<{ type: string; indexed?: boolean }>;
    outputs?: Array<{ type: string }>;
    stateMutability?: string;
  }>;

  const sig = (item: (typeof compiled)[number]) =>
    JSON.stringify([
      item.type,
      item.name,
      (item.inputs ?? []).map((i) => [i.type, item.type === 'event' ? Boolean(i.indexed) : undefined]),
      (item.outputs ?? []).map((o) => o.type),
      item.type === 'function' ? item.stateMutability : undefined,
    ]);

  for (const item of registryAbi) {
    if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') continue;
    it(`${item.type} ${item.name} matches the compiled ABI`, () => {
      const match = compiled.find((c) => c.type === item.type && c.name === item.name);
      expect(match, `${item.name} is not in StrategyRegistry.json`).toBeDefined();
      expect(sig(item as never)).toBe(sig(match!));
    });
  }
});

/** A fake EIP-1193 wallet that records what it was asked and answers like a node would. */
function fakeWallet(opts: { reject?: boolean } = {}) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return toHex(monad.id);
        case 'wallet_switchEthereumChain':
          return null;
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [ACCOUNT];
        case 'eth_sendTransaction':
          if (opts.reject) {
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          }
          return TX;
        case 'personal_sign':
          if (opts.reject) {
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          }
          return SIGNATURE;
        default:
          throw new Error(`unexpected wallet call ${method}`);
      }
    },
  };
  return { provider, calls };
}

/** A fake node: answers `minBond` and returns a receipt carrying whatever logs it is given. */
function fakeNode(input: { status?: '0x1' | '0x0'; logs?: unknown[]; canonical?: boolean } = {}) {
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case 'eth_chainId':
        return toHex(monad.id);
      case 'eth_call': {
        const data = (params as Array<{ data: Hex }>)[0]!.data;
        // minBond() selector.
        if (data === keccak256(toHex('minBond()')).slice(0, 10)) {
          return encodeAbiParameters([{ type: 'uint256' }], [MIN_BOND]);
        }
        if (data.startsWith(keccak256(toHex('isCanonicalSeries(address)')).slice(0, 10))) {
          return encodeAbiParameters([{ type: 'bool' }], [input.canonical ?? true]);
        }
        throw new Error(`unexpected eth_call ${data}`);
      }
      case 'eth_getTransactionByHash':
        return null;
      case 'eth_getTransactionReceipt':
        return {
          transactionHash: TX,
          transactionIndex: '0x0',
          blockHash: `0x${'11'.repeat(32)}`,
          blockNumber: '0x10',
          from: ACCOUNT,
          to: REGISTRY,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          status: input.status ?? '0x1',
          type: '0x2',
          logs: input.logs ?? [],
        };
      case 'eth_blockNumber':
        return '0x10';
      default:
        throw new Error(`unexpected node call ${method}`);
    }
  };
  return custom({ request } as never);
}

function pinnedData(over: { specHash?: Hex; commitment?: Hex; series?: `0x${string}` } = {}) {
  return encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }],
    [over.specHash ?? SPEC_HASH, MIN_BOND, over.commitment ?? COMMITMENT, over.series ?? SERIES],
  );
}

function log(topics: Hex[], data: Hex) {
  return {
    address: REGISTRY,
    topics,
    data,
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: '0x10',
    transactionHash: TX,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

function clientWith(wallet: ReturnType<typeof fakeWallet>, node: ReturnType<typeof fakeNode>) {
  return createViemPinClient({
    chain: monad,
    registryAddress: REGISTRY,
    hasWallet: true,
    getSigner: async () => ({ provider: wallet.provider as never, address: ACCOUNT }),
    publicTransport: node,
  });
}

describe('createViemPinClient', () => {
  it('reads the registry minimum as the bond, at the chain native decimals', async () => {
    const client = clientWith(fakeWallet(), fakeNode());
    expect(await client.readMinBond()).toEqual({ atoms: MIN_BOND.toString(), decimals: 18 });
    expect(client.chainId).toBe(143);
    expect(client.nativeSymbol).toBe('MON');
  });

  it('pins by sending the hash with the minimum bond, and returns the registry id from the event', async () => {
    const wallet = fakeWallet();
    const topics = encodeEventTopics({
      abi: registryAbi,
      eventName: 'StrategyPinned',
      args: { strategyId: 7n, owner: ACCOUNT },
    });
    const data = pinnedData();
    const client = clientWith(wallet, fakeNode({ logs: [log(topics as Hex[], data)] }));

    const receipt = await client.pin(TARGET);

    expect(receipt.txHash).toBe(TX);
    expect(receipt.chainStrategyId).toBe('7');
    expect(receipt.bond).toEqual({ atoms: MIN_BOND.toString(), decimals: 18 });
    expect(receipt.chainId).toBe(143);
    expect(receipt.registryAddress).toBe(REGISTRY);
    // The receipt carries what the registry recorded, read back from the event.
    expect(receipt.predicatesCommitment).toBe(COMMITMENT);
    expect(receipt.series.toLowerCase()).toBe(SERIES.toLowerCase());

    const sent = wallet.calls.find((c) => c.method === 'eth_sendTransaction');
    const tx = (sent!.params as Array<{ to: string; value: Hex; data: Hex; from: string }>)[0]!;
    expect(tx.to.toLowerCase()).toBe(REGISTRY);
    expect(BigInt(tx.value)).toBe(MIN_BOND);
    // pinStrategy(bytes32,bytes32,address) selector, then hash, commitment and series, in that order.
    const selector = keccak256(toHex('pinStrategy(bytes32,bytes32,address)')).slice(0, 10);
    expect(tx.data.startsWith(selector)).toBe(true);
    expect(tx.data.slice(10)).toBe(
      `${SPEC_HASH.slice(2)}${COMMITMENT.slice(2)}${SERIES.slice(2).toLowerCase().padStart(64, '0')}`,
    );
  });

  it('does not report a pin when the registry emitted none', async () => {
    const client = clientWith(fakeWallet(), fakeNode({ logs: [] }));
    await expect(client.pin(TARGET)).rejects.toMatchObject({ code: 'failed' });
  });

  it('does not report a pin when the transaction reverted', async () => {
    const client = clientWith(fakeWallet(), fakeNode({ status: '0x0' }));
    await expect(client.pin(TARGET)).rejects.toMatchObject({ code: 'failed' });
  });

  it('a declined signature is "rejected", not a failure', async () => {
    const client = clientWith(fakeWallet({ reject: true }), fakeNode());
    const err = await client.pin(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PinError);
    expect((err as PinError).code).toBe('rejected');
    expect((err as PinError).message).toMatch(/nothing was pinned/i);
  });

  it('refuses a malformed hash, commitment or series before it asks anything to sign', async () => {
    const wallet = fakeWallet();
    const client = clientWith(wallet, fakeNode());
    await expect(client.pin({ ...TARGET, specHash: '0x1234' })).rejects.toMatchObject({ code: 'failed' });
    await expect(client.pin({ ...TARGET, predicatesCommitment: '0x12' })).rejects.toMatchObject({ code: 'failed' });
    await expect(client.pin({ ...TARGET, series: '0xnot-an-address' })).rejects.toMatchObject({ code: 'failed' });
    expect(wallet.calls.find((c) => c.method === 'eth_sendTransaction')).toBeUndefined();
  });

  it('asks the registry whether the series is canonical, and does not sign when it is not', async () => {
    const wallet = fakeWallet();
    const client = clientWith(wallet, fakeNode({ canonical: false }));
    const err = await client.pin(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PinError);
    expect((err as PinError).code).toBe('not_deployed');
    expect((err as PinError).message).toMatch(/canonical/i);
    expect(wallet.calls.find((c) => c.method === 'eth_sendTransaction')).toBeUndefined();
  });

  it('does not report a pin the registry recorded differently from what was sent', async () => {
    const topics = encodeEventTopics({
      abi: registryAbi,
      eventName: 'StrategyPinned',
      args: { strategyId: 7n, owner: ACCOUNT },
    });
    for (const over of [
      { commitment: `0x${'11'.repeat(32)}` as Hex },
      { series: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' as const },
      { specHash: `0x${'22'.repeat(32)}` as Hex },
    ]) {
      const client = clientWith(fakeWallet(), fakeNode({ logs: [log(topics as Hex[], pinnedData(over))] }));
      await expect(client.pin(TARGET)).rejects.toMatchObject({ code: 'failed' });
    }
  });

  it('exposes the series it was configured with, none by default', () => {
    const a = createViemPinClient({
      chain: monad,
      registryAddress: REGISTRY,
      hasWallet: true,
      getSigner: async () => null,
      publicTransport: fakeNode(),
      series: { 'BTC/USD': { address: SERIES } },
    });
    expect(a.series['BTC/USD']?.address).toBe(SERIES);
    expect(clientWith(fakeWallet(), fakeNode()).series).toEqual({});
  });

  it('is not deployed without a registry address, and never reaches a wallet', async () => {
    const wallet = fakeWallet();
    const client = createViemPinClient({
      chain: monad,
      registryAddress: undefined,
      hasWallet: true,
      getSigner: async () => ({ provider: wallet.provider as never, address: ACCOUNT }),
      publicTransport: fakeNode(),
    });
    expect(client.availability().state).toBe('not_deployed');
    await expect(client.pin(TARGET)).rejects.toMatchObject({ code: 'not_deployed' });
    expect(wallet.calls).toHaveLength(0);
  });

  it('reports no wallet when none exists', async () => {
    const client = createViemPinClient({
      chain: monad,
      registryAddress: REGISTRY,
      hasWallet: false,
      getSigner: async () => null,
      publicTransport: fakeNode(),
    });
    expect(client.availability().state).toBe('no_wallet');
    await expect(client.pin(TARGET)).rejects.toMatchObject({ code: 'no_wallet' });
  });

  it('proposeLoosening returns the registry cooldown end from its event, in milliseconds', async () => {
    const topics = encodeEventTopics({
      abi: registryAbi,
      eventName: 'LooseningProposed',
      args: { strategyId: 7n },
    });
    const data = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      [SPEC_HASH, COMMITMENT, SERIES, 1_800_086_400n],
    );
    const client = clientWith(fakeWallet(), fakeNode({ logs: [log(topics as Hex[], data)] }));
    const out = await client.proposeLoosening('7', TARGET);
    expect(out.txHash).toBe(TX);
    expect(out.cooldownEndsAtMs).toBe(1_800_086_400_000);
  });

  it('tighten and finalizeLoosening send their calls and return the hash', async () => {
    const wallet = fakeWallet();
    const client = clientWith(wallet, fakeNode());
    expect((await client.tighten('7', TARGET, { old: [], next: [] })).txHash).toBe(TX);
    expect((await client.finalizeLoosening('7')).txHash).toBe(TX);
    const sent = wallet.calls.filter((c) => c.method === 'eth_sendTransaction');
    expect(sent).toHaveLength(2);
    // tighten carries id, hash, commitment and series; finalize carries only the id.
    const tighten = (sent[0]!.params as Array<{ data: Hex }>)[0]!.data;
    expect(tighten.startsWith(keccak256(toHex(TIGHTEN_SIG)).slice(0, 10))).toBe(true);
    expect(tighten.slice(10).startsWith(
      `${'7'.padStart(64, '0')}${SPEC_HASH.slice(2)}${COMMITMENT.slice(2)}${SERIES.slice(2).toLowerCase().padStart(64, '0')}`,
    )).toBe(true);
  });

  it('signs the link message with the connected wallet, and sends no transaction for it', async () => {
    const wallet = fakeWallet();
    const client = clientWith(wallet, fakeNode());
    expect(await client.signMessage!('Link this wallet')).toBe(SIGNATURE);
    const signed = wallet.calls.find((c) => c.method === 'personal_sign');
    expect(signed!.params).toEqual([toHex('Link this wallet'), ACCOUNT]);
    expect(wallet.calls.find((c) => c.method === 'eth_sendTransaction')).toBeUndefined();
  });

  it('a declined link signature is "rejected", and no wallet is "no_wallet"', async () => {
    const declined = clientWith(fakeWallet({ reject: true }), fakeNode());
    await expect(declined.signMessage!('Link this wallet')).rejects.toMatchObject({
      name: 'PinError',
      code: 'rejected',
    });
    const none = createViemPinClient({
      chain: monad,
      registryAddress: REGISTRY,
      hasWallet: true,
      getSigner: async () => null,
      publicTransport: fakeNode(),
    });
    await expect(none.signMessage!('Link this wallet')).rejects.toMatchObject({ code: 'no_wallet' });
  });

  it('proposeLoosening sends the new commitment and series too', async () => {
    const wallet = fakeWallet();
    const client = clientWith(wallet, fakeNode());
    await client.proposeLoosening('7', TARGET);
    const data = (wallet.calls.find((c) => c.method === 'eth_sendTransaction')!.params as Array<{ data: Hex }>)[0]!.data;
    expect(data.startsWith(keccak256(toHex('proposeLoosening(uint256,bytes32,bytes32,address)')).slice(0, 10))).toBe(true);
    expect(data.endsWith(SERIES.slice(2).toLowerCase().padStart(64, '0'))).toBe(true);
  });
});
