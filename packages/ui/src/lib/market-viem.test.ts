import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
  type EIP1193Provider,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { MarketError, type ChainMarketRef, type OnChainTerms } from './market-client';
import {
  canonicalSeriesAbi,
  revertName,
  createViemMarketClient,
  seriesIdFor,
  thresholdMarketAbi,
  toMarketError,
} from './market-viem';

const chain = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:0'] } },
});

const MARKET = '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6' as const;
const SERIES = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9' as const;
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TX = `0x${'ab'.repeat(32)}` as const;

const terms: OnChainTerms = {
  asset: 'BTC/USD',
  direction: 'above',
  thresholdPrice: { atoms: '68755', decimals: 0 },
  windowStart: 1_800_000_900,
  windowEnd: 1_800_014_400,
  bucketSeconds: 900,
};
const THRESHOLD_UNITS = 6_875_500_000_000n;

describe('ABI', () => {
  const json = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../contracts/abi/ThresholdMarket.json', import.meta.url)),
      'utf8',
    ),
  ) as Array<{ type: string; name: string; inputs: Array<{ type: string }>; outputs?: Array<{ type: string }> }>;
  const seriesJson = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../contracts/abi/CanonicalSeries.json', import.meta.url)),
      'utf8',
    ),
  ) as typeof json;

  const sig = (i: { name: string; inputs: Array<{ type: string }> }) =>
    `${i.name}(${i.inputs.map((x) => x.type).join(',')})`;

  it('every function the client calls exists in the contract ABI with the same signature and outputs', () => {
    for (const item of thresholdMarketAbi.filter((i) => i.type === 'function')) {
      const match = json.find((j) => j.type === 'function' && sig(j) === sig(item as never));
      expect(match, `${sig(item as never)} is missing from ThresholdMarket.json`).toBeDefined();
      expect((match!.outputs ?? []).map((o) => o.type)).toEqual(
        ((item as unknown as { outputs: Array<{ type: string }> }).outputs ?? []).map((o) => o.type),
      );
    }
  });

  it('the event the client decodes has the contract\'s signature', () => {
    const ev = json.find((j) => j.type === 'event' && j.name === 'MarketOpened');
    expect(ev?.inputs.map((i) => i.type)).toEqual(['uint256', 'bytes32', 'int256', 'bool', 'uint256', 'uint256']);
  });

  it('every custom error the client maps exists in the contract ABI', () => {
    const errors = json.filter((j) => j.type === 'error').map((j) => j.name);
    for (const item of thresholdMarketAbi.filter((i) => i.type === 'error')) {
      expect(errors, `${item.name} is missing from ThresholdMarket.json`).toContain(item.name);
    }
    expect(errors).toEqual(expect.arrayContaining(['MarketCrossed', 'StaleSeries']));
  });

  it('every series function the client calls exists on CanonicalSeries', () => {
    for (const item of canonicalSeriesAbi) {
      const match = seriesJson.find((j) => j.type === 'function' && sig(j) === sig(item as never));
      expect(match, `${sig(item as never)} is missing from CanonicalSeries.json`).toBeDefined();
    }
  });

  it('has a stable selector for takeSide', () => {
    expect(toFunctionSelector('takeSide(uint256,bool)')).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

describe('seriesIdFor', () => {
  it('is keccak256 of the symbol, as Deploy.s.sol registers it', () => {
    expect(seriesIdFor('BTC/USD')).toBe('0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489');
    expect(seriesIdFor('ETH/USD')).not.toBe(seriesIdFor('BTC/USD'));
  });
});

describe('revertName', () => {
  it('finds the decoded contract error however deep viem nests it', () => {
    expect(revertName({ cause: { cause: { data: { errorName: 'StaleSeries' } } } })).toBe('StaleSeries');
    expect(revertName(new Error('plain'))).toBeUndefined();
    expect(revertName(null)).toBeUndefined();
  });
});

describe('toMarketError', () => {
  it('reads a declined signature as rejected, from the error or its cause', () => {
    expect(toMarketError({ name: 'UserRejectedRequestError' }).code).toBe('rejected');
    expect(toMarketError({ code: 4001 }).code).toBe('rejected');
    expect(toMarketError({ cause: { code: 4001 } }).code).toBe('rejected');
  });
  it('keeps a MarketError as it is, and calls anything else failed', () => {
    const e = new MarketError('mismatch', 'x');
    expect(toMarketError(e)).toBe(e);
    expect(toMarketError(new Error('boom')).code).toBe('failed');
  });
});

interface FakeChain {
  seriesAddress?: string;
  priceExpoSet?: boolean;
  bucketSeconds?: number;
  expo?: number;
  /** What `markets(id)` returns. */
  row?: readonly [string, bigint, boolean, bigint, bigint, bigint, bigint, boolean, boolean, boolean];
  /** The market id the MarketOpened log carries. */
  openedId?: bigint;
  receiptStatus?: 'success' | 'reverted';
  /** What `hasCrossed(id)` returns. */
  crossed?: boolean;
  /** A contract error the dry run of `takeSide` reverts with. */
  simulateRevert?: string;
}

function fakes(cfg: FakeChain = {}, opts: { reject?: boolean } = {}) {
  const sent: Array<{ to: string; data: `0x${string}`; value?: string; from: string }> = [];
  const simulated: unknown[] = [];

  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x8f';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        sent.push((params as unknown[])[0] as (typeof sent)[number]);
        return TX;
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  } as unknown as EIP1193Provider;

  const publicClient = {
    readContract: async (call: { address: string; functionName: string; args?: unknown[] }) => {
      switch (call.functionName) {
        case 'series':
          return cfg.seriesAddress ?? SERIES;
        case 'priceExpoSet':
          return cfg.priceExpoSet ?? true;
        case 'bucketSeconds':
          return BigInt(cfg.bucketSeconds ?? 900);
        case 'priceExpo':
          return cfg.expo ?? -8;
        case 'markets':
          if (!cfg.row) throw new Error('no row');
          return cfg.row;
        case 'hasCrossed':
          return cfg.crossed ?? false;
        default:
          throw new Error(`unexpected read ${call.functionName}`);
      }
    },
    simulateContract: async (call: unknown) => {
      simulated.push(call);
      if (cfg.simulateRevert) {
        // What viem throws: a wrapper whose cause carries the decoded contract error.
        throw Object.assign(new Error('The contract function "takeSide" reverted.'), {
          cause: Object.assign(new Error('reverted'), { data: { errorName: cfg.simulateRevert } }),
        });
      }
      return { request: {} };
    },
    waitForTransactionReceipt: async () => {
      const topics = encodeEventTopics({
        abi: thresholdMarketAbi,
        eventName: 'MarketOpened',
        args: { marketId: cfg.openedId ?? 7n, seriesId: seriesIdFor('BTC/USD') },
      });
      const data = encodeAbiParameters(
        [
          { type: 'int256' },
          { type: 'bool' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        [THRESHOLD_UNITS, true, BigInt(terms.windowStart), BigInt(terms.windowEnd)],
      );
      return {
        status: cfg.receiptStatus ?? 'success',
        logs: [
          // A log from some other contract in the same transaction must be skipped, not fatal.
          { address: '0x0000000000000000000000000000000000000001', data: '0x', topics: ['0x1234'] },
          { address: MARKET, data, topics },
        ],
      };
    },
  };

  const client = createViemMarketClient({
    chain,
    marketAddress: MARKET,
    hasWallet: true,
    getSigner: async () => ({ provider, address: ACCOUNT }),
    publicClient: publicClient as never,
  });
  return { client, sent, simulated };
}

describe('createViemMarketClient', () => {
  it('is not deployed without an address, and refuses before touching a wallet', async () => {
    const c = createViemMarketClient({
      chain,
      marketAddress: undefined,
      hasWallet: true,
      getSigner: async () => {
        throw new Error('must not be asked to sign');
      },
      publicClient: {} as never,
    });
    expect(c.availability().state).toBe('not_deployed');
    await expect(c.ensureMarket(terms)).rejects.toMatchObject({ code: 'not_deployed' });
    await expect(c.takeSide({ chainMarketId: '1', yes: true, stake: { atoms: '1', decimals: 18 } })).rejects.toMatchObject({
      code: 'not_deployed',
    });
  });

  it('reports no wallet when there is a contract but no signer', async () => {
    const c = createViemMarketClient({
      chain,
      marketAddress: MARKET,
      hasWallet: false,
      getSigner: async () => null,
      publicClient: {} as never,
    });
    expect(c.availability().state).toBe('no_wallet');
    await expect(c.takeSide({ chainMarketId: '1', yes: true, stake: { atoms: '1', decimals: 18 } })).rejects.toMatchObject({
      code: 'no_wallet',
    });
  });

  it('exposes the chain it is bound to', () => {
    const { client } = fakes();
    expect(client.chainId).toBe(143);
    expect(client.nativeSymbol).toBe('MON');
    expect(client.availability()).toEqual({ state: 'ready' });
  });

  describe('ensureMarket', () => {
    it('opens a market that is not yet on-chain, in the series\' own units, and reads its id from the event', async () => {
      const { client, sent } = fakes({ openedId: 7n });
      const m = await client.ensureMarket(terms);
      expect(m).toMatchObject({ chainId: 143, address: MARKET, marketId: '7', txHash: TX, opened: true });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.to.toLowerCase()).toBe(MARKET.toLowerCase());
      const decoded = decodeFunctionData({ abi: thresholdMarketAbi, data: sent[0]!.data });
      expect(decoded.functionName).toBe('openMarket');
      expect(decoded.args).toEqual([
        seriesIdFor('BTC/USD'),
        THRESHOLD_UNITS,
        true,
        BigInt(terms.windowStart),
        BigInt(terms.windowEnd),
      ]);
    });

    it('opens a `below` market with above = false', async () => {
      const { client, sent } = fakes();
      await client.ensureMarket({ ...terms, direction: 'below' });
      const decoded = decodeFunctionData({ abi: thresholdMarketAbi, data: sent[0]!.data });
      expect(decoded.args?.[2]).toBe(false);
    });

    it('refuses an asset with no series registered, and sends nothing', async () => {
      const { client, sent } = fakes({ seriesAddress: '0x0000000000000000000000000000000000000000' });
      await expect(client.ensureMarket(terms)).rejects.toMatchObject({ code: 'not_open' });
      expect(sent).toHaveLength(0);
    });

    it('refuses a series that has not recorded a sample, so has no price scale', async () => {
      const { client, sent } = fakes({ priceExpoSet: false });
      await expect(client.ensureMarket(terms)).rejects.toMatchObject({ code: 'not_open' });
      expect(sent).toHaveLength(0);
    });

    it('refuses a series bucketed at a different width than the market is decided on', async () => {
      const { client, sent } = fakes({ bucketSeconds: 300 });
      await expect(client.ensureMarket(terms)).rejects.toMatchObject({ code: 'mismatch' });
      expect(sent).toHaveLength(0);
    });

    it('refuses a threshold the series scale cannot hold exactly', async () => {
      const { client, sent } = fakes({ expo: 0 });
      await expect(
        client.ensureMarket({ ...terms, thresholdPrice: { atoms: '6875501', decimals: 2 } }),
      ).rejects.toMatchObject({ code: 'mismatch' });
      expect(sent).toHaveLength(0);
    });

    it('fails when the open transaction reverts, rather than reporting a market', async () => {
      const { client } = fakes({ receiptStatus: 'reverted' });
      await expect(client.ensureMarket(terms)).rejects.toMatchObject({ code: 'failed' });
    });

    it('reads a linked market back and accepts it when every field matches, sending nothing', async () => {
      const linked: ChainMarketRef = { chainId: 143, address: MARKET, marketId: '3', txHash: TX };
      const { client, sent } = fakes({
        row: [SERIES, THRESHOLD_UNITS, true, BigInt(terms.windowStart), BigInt(terms.windowEnd), 0n, 0n, false, false, false],
      });
      const m = await client.ensureMarket(terms, linked);
      expect(m).toMatchObject({ marketId: '3', opened: false });
      expect(sent).toHaveLength(0);
    });

    it('refuses a linked market whose on-chain threshold is not the one on the card', async () => {
      const linked: ChainMarketRef = { chainId: 143, address: MARKET, marketId: '3', txHash: TX };
      const { client, sent } = fakes({
        row: [SERIES, THRESHOLD_UNITS + 1n, true, BigInt(terms.windowStart), BigInt(terms.windowEnd), 0n, 0n, false, false, false],
      });
      await expect(client.ensureMarket(terms, linked)).rejects.toMatchObject({ code: 'mismatch' });
      expect(sent).toHaveLength(0);
    });

    it('refuses a link to another contract or another chain', async () => {
      const { client } = fakes({
        row: [SERIES, THRESHOLD_UNITS, true, BigInt(terms.windowStart), BigInt(terms.windowEnd), 0n, 0n, false, false, false],
      });
      await expect(
        client.ensureMarket(terms, { chainId: 143, address: SERIES, marketId: '3', txHash: TX }),
      ).rejects.toMatchObject({ code: 'mismatch' });
      await expect(
        client.ensureMarket(terms, { chainId: 1, address: MARKET, marketId: '3', txHash: TX }),
      ).rejects.toMatchObject({ code: 'mismatch' });
    });

    it('reports a declined signature as rejected', async () => {
      const { client } = fakes({}, { reject: true });
      await expect(client.ensureMarket(terms)).rejects.toMatchObject({ code: 'rejected' });
    });
  });

  describe('hasCrossed', () => {
    it('reads the contract\'s own answer', async () => {
      expect(await fakes({ crossed: true }).client.hasCrossed('7')).toBe(true);
      expect(await fakes({ crossed: false }).client.hasCrossed('7')).toBe(false);
    });
    it('refuses a market with no on-chain id', async () => {
      await expect(fakes().client.hasCrossed('seven')).rejects.toMatchObject({ code: 'not_open' });
    });
  });

  describe('takeSide', () => {
    it('sends the stake as value with the side as the contract\'s YES/NO flag', async () => {
      const { client, sent } = fakes();
      const r = await client.takeSide({
        chainMarketId: '7',
        yes: true,
        stake: { atoms: '10000000000000000', decimals: 18 },
      });
      expect(r.txHash).toBe(TX);
      const decoded = decodeFunctionData({ abi: thresholdMarketAbi, data: sent[0]!.data });
      expect(decoded.functionName).toBe('takeSide');
      expect(decoded.args).toEqual([7n, true]);
      expect(BigInt(sent[0]!.value ?? '0x0')).toBe(10n ** 16n);
    });

    it('sends NO as false', async () => {
      const { client, sent } = fakes();
      await client.takeSide({ chainMarketId: '7', yes: false, stake: { atoms: '1', decimals: 2 } });
      const decoded = decodeFunctionData({ abi: thresholdMarketAbi, data: sent[0]!.data });
      expect(decoded.args).toEqual([7n, false]);
    });

    it('refuses a zero stake and a market with no id, sending nothing', async () => {
      const { client, sent } = fakes();
      await expect(
        client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '0', decimals: 18 } }),
      ).rejects.toMatchObject({ code: 'failed' });
      await expect(
        client.takeSide({ chainMarketId: 'seven', yes: true, stake: { atoms: '1', decimals: 18 } }),
      ).rejects.toMatchObject({ code: 'not_open' });
      expect(sent).toHaveLength(0);
    });

    it('dry-runs the exact call from the signer before anything is signed', async () => {
      const { client, simulated, sent } = fakes();
      await client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } });
      expect(simulated).toHaveLength(1);
      expect(simulated[0]).toMatchObject({ functionName: 'takeSide', args: [7n, true], account: ACCOUNT, value: 1n });
      expect(sent).toHaveLength(1);
    });

    it('reports a market the contract has already seen crossed as closed, without asking a wallet to sign', async () => {
      const { client, sent, simulated } = fakes({ crossed: true });
      await expect(
        client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } }),
      ).rejects.toMatchObject({ code: 'crossed', message: 'Closed: threshold already crossed' });
      expect(sent).toHaveLength(0);
      expect(simulated).toHaveLength(0);
    });

    it('maps a MarketCrossed revert from the dry run to crossed', async () => {
      const { client, sent } = fakes({ simulateRevert: 'MarketCrossed' });
      await expect(
        client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } }),
      ).rejects.toMatchObject({ code: 'crossed' });
      expect(sent).toHaveLength(0);
    });

    it('maps a StaleSeries revert to a wait for a fresh price, not a failure', async () => {
      const { client, sent } = fakes({ simulateRevert: 'StaleSeries' });
      await expect(
        client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } }),
      ).rejects.toMatchObject({ code: 'stale', message: 'Waiting for a fresh price' });
      expect(sent).toHaveLength(0);
    });

    it('maps MarketClosed and UnknownMarket to not_open', async () => {
      for (const name of ['MarketClosed', 'UnknownMarket']) {
        const { client } = fakes({ simulateRevert: name });
        await expect(
          client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } }),
        ).rejects.toMatchObject({ code: 'not_open' });
      }
    });

    it('does not report a side taken when the transaction reverted', async () => {
      const { client } = fakes({ receiptStatus: 'reverted' });
      await expect(
        client.takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } }),
      ).rejects.toMatchObject({ code: 'failed' });
    });

    it('reports a declined signature as rejected: nothing staked', async () => {
      const { client } = fakes({}, { reject: true });
      const err = await client
        .takeSide({ chainMarketId: '7', yes: true, stake: { atoms: '1', decimals: 18 } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketError);
      expect((err as MarketError).code).toBe('rejected');
    });
  });
});
