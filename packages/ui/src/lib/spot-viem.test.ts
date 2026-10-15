import { describe, expect, it } from 'vitest';
import { custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { monadTestnet } from './monad-chain';
import { DEFAULT_SLIPPAGE_BPS, REVERTED_LINE, readSpotMarketAnswer, sizeSpotOrder, type SpotMarket, type SpotStep } from './spot';
import { SpotError, unavailableSpotClient } from './spot-client';
import { createViemSpotClient, kuruOrderBookAbi, spotTokenAbi } from './spot-viem';

const BOOK = '0x4aC0501686D10048d083Ae8d1e13b9817FF1FF41' as const;
const BASE = '0x85495222Fd7069B987Ca38C2142732EbBFb7175D' as const;
const QUOTE = '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C' as const;
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as const;
const MAKER = '0x00000000000000000000000000000000000000bb' as const;
const TX_FIRST = `0x${'a1'.repeat(32)}` as Hex;
const TX_SECOND = `0x${'b2'.repeat(32)}` as Hex;
const ONE_MON = 10n ** 18n;

const selector = (signature: string) => keccak256(toHex(signature)).slice(0, 10);
const BALANCE_OF = selector('balanceOf(address)');
const ALLOWANCE = selector('allowance(address,address)');
// The signatures as the listing was rehearsed with them, written out so the typed ABI cannot drift from them.
const MARKET_BUY = selector('placeAndExecuteMarketBuy(uint96,uint256,bool,bool)');
const MARKET_SELL = selector('placeAndExecuteMarketSell(uint96,uint256,bool,bool)');
const APPROVE = selector('approve(address,uint256)');
const MINT = selector('mint(address,uint256)');
const TRADE_TOPIC = keccak256(toHex('Trade(uint40,address,bool,uint256,uint96,address,address,uint96)'));

const MARKET: SpotMarket = (() => {
  const read = readSpotMarketAnswer({
    ok: true,
    asset: 'tkBTC/USDC',
    network: 'testnet',
    chainId: 10143,
    market: BOOK,
    base: { address: BASE, name: 'Kanon Test BTC', symbol: 'tkBTC', decimals: 8, kind: 'test token, open mint' },
    quote: { address: QUOTE, name: 'Mock USDC', symbol: 'USDC', decimals: 6, kind: 'mock, open mint' },
    note: 'tkBTC is a test token. It is not bitcoin.',
    priceDecimals: 4,
    sizeDecimals: 9,
    minSize: { atoms: '100000', decimals: 9 },
    maxSize: { atoms: '1000000000', decimals: 9 },
    takerFeeBps: 30,
    bids: [{ price: { atoms: '824475248', decimals: 4 }, size: { atoms: '250000000', decimals: 9 } }],
    asks: [{ price: { atoms: '832720000', decimals: 4 }, size: { atoms: '248756210', decimals: 9 } }],
    blockNumber: 1,
    readAt: 1,
    listing: {},
  });
  if (!read || !read.ok) throw new Error('the fixture is not a market');
  return read.market;
})();

function order(side: 'buy' | 'sell', amount: string) {
  const sized = sizeSpotOrder({ market: MARKET, side, amount, slippageBps: DEFAULT_SLIPPAGE_BPS });
  if (!sized.ok) throw new Error(sized.message);
  return sized.order;
}

/** A fake EIP-1193 wallet that records what it was asked and hands back one hash per transaction, in order. */
function fakeWallet(opts: { reject?: boolean; chainId?: number; cannotSwitch?: boolean } = {}) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const hashes = [TX_FIRST, TX_SECOND];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return toHex(opts.chainId ?? monadTestnet.id);
        case 'wallet_switchEthereumChain':
          if (opts.cannotSwitch) throw Object.assign(new Error('Unrecognized chain.'), { code: 4902 });
          return null;
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [ACCOUNT];
        case 'eth_sendTransaction':
          if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          return hashes.shift();
        default:
          throw new Error(`unexpected wallet call ${method}`);
      }
    },
  };
  const sent = () =>
    calls
      .filter((c) => c.method === 'eth_sendTransaction')
      .map((c) => (c.params as Array<{ to: string; data: Hex; value?: Hex; from: string }>)[0]!);
  return { provider, calls, sent };
}

function tradeLog(input: { taker: string; price: bigint; filled: bigint; address?: string }) {
  return {
    address: input.address ?? BOOK,
    topics: encodeEventTopics({ abi: kuruOrderBookAbi, eventName: 'Trade' }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'uint40' },
        { type: 'address' },
        { type: 'bool' },
        { type: 'uint256' },
        { type: 'uint96' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint96' },
      ],
      [7, MAKER, false, input.price, 0n, input.taker as `0x${string}`, ACCOUNT, input.filled],
    ),
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: '0x10',
    transactionHash: TX_FIRST,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

/** A fake node: gas, token balances, a queue of allowances per token, a dry-run that passes or reverts, and receipts by hash. */
function fakeNode(
  input: {
    gas?: bigint;
    balances?: { base?: bigint; quote?: bigint };
    /** Each read takes the next value; the last one stays. */
    allowances?: { base?: bigint[]; quote?: bigint[] };
    dryRun?: 'passes' | 'reverts';
    receipts?: Record<string, { status?: '0x1' | '0x0'; logs?: unknown[] } | 'missing'>;
  } = {},
) {
  const calls: string[] = [];
  const allowances = { [BASE.toLowerCase()]: [...(input.allowances?.base ?? [0n])], [QUOTE.toLowerCase()]: [...(input.allowances?.quote ?? [0n])] };
  const uint = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return toHex(monadTestnet.id);
      case 'eth_getBalance':
        return toHex(input.gas ?? ONE_MON);
      case 'eth_call': {
        const call = (params as Array<{ to: string; data: Hex }>)[0]!;
        const to = call.to.toLowerCase();
        if (call.data.startsWith(BALANCE_OF)) {
          return uint(to === BASE.toLowerCase() ? (input.balances?.base ?? 0n) : (input.balances?.quote ?? 0n));
        }
        if (call.data.startsWith(ALLOWANCE)) {
          const queue = allowances[to] ?? [0n];
          return uint(queue.length > 1 ? queue.shift()! : queue[0]!);
        }
        if (call.data.startsWith(MARKET_BUY) || call.data.startsWith(MARKET_SELL)) {
          calls.push('dry-run');
          if (input.dryRun === 'reverts') throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
          return uint(0n);
        }
        throw new Error(`unexpected eth_call ${call.data}`);
      }
      case 'eth_getTransactionByHash':
        return null;
      case 'eth_getTransactionReceipt': {
        const hash = (params as Hex[])[0]!;
        const receipt = input.receipts?.[hash] ?? {};
        if (receipt === 'missing') throw new Error('the node is not answering');
        return {
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: `0x${'11'.repeat(32)}`,
          blockNumber: '0x10',
          from: ACCOUNT,
          to: BOOK,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          status: receipt.status ?? '0x1',
          type: '0x2',
          logs: receipt.logs ?? [],
        };
      }
      case 'eth_blockNumber':
        return '0x10';
      default:
        throw new Error(`unexpected node call ${method}`);
    }
  };
  // No retries: a real node's revert is not retried either, and a test should not wait out a back-off.
  return { transport: custom({ request } as never, { retryCount: 0 }), calls };
}

function clientWith(
  wallet: ReturnType<typeof fakeWallet>,
  node: ReturnType<typeof fakeNode>,
  over: { hasWallet?: boolean; receiptTimeoutMs?: number } = {},
) {
  return createViemSpotClient({
    chain: monadTestnet,
    hasWallet: over.hasWallet ?? true,
    getSigner: async () => ({ provider: wallet.provider as never, address: ACCOUNT }),
    publicTransport: node.transport,
    ...(over.receiptTimeoutMs !== undefined ? { receiptTimeoutMs: over.receiptTimeoutMs } : {}),
  });
}

const failure = async (run: Promise<unknown>): Promise<SpotError> => {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SpotError);
  return err as SpotError;
};

describe('the two ABIs', () => {
  it('encode the calls and the event the listing was rehearsed with', () => {
    const data = (abi: unknown, name: string) =>
      (abi as Array<{ type: string; name?: string }>).some((item) => item.name === name);
    for (const name of ['balanceOf', 'allowance', 'approve', 'mint']) expect(data(spotTokenAbi, name)).toBe(true);
    for (const name of ['placeAndExecuteMarketBuy', 'placeAndExecuteMarketSell', 'Trade']) expect(data(kuruOrderBookAbi, name)).toBe(true);
    expect(encodeEventTopics({ abi: kuruOrderBookAbi, eventName: 'Trade' })).toEqual([TRADE_TOPIC]);
  });
});

describe('createViemSpotClient: reading the wallet', () => {
  it('reads gas, both balances and both allowances, each at its own decimals', async () => {
    const node = fakeNode({
      gas: 5n * ONE_MON,
      balances: { base: 99_700n, quote: 1_000_000_000n },
      allowances: { base: [0n], quote: [83_272_000n] },
    });
    const wallet = await clientWith(fakeWallet(), node).readWallet(MARKET);
    expect(wallet).toEqual({
      address: ACCOUNT,
      native: { atoms: (5n * ONE_MON).toString(), decimals: 18 },
      nativeSymbol: 'MON',
      base: { atoms: '99700', decimals: 8 },
      quote: { atoms: '1000000000', decimals: 6 },
      baseAllowance: { atoms: '0', decimals: 8 },
      quoteAllowance: { atoms: '83272000', decimals: 6 },
    });
  });

  it('reads nothing for a market on another chain than the one it signs for', async () => {
    const node = fakeNode();
    const err = await failure(clientWith(fakeWallet(), node).readWallet({ ...MARKET, chainId: 143 }));
    expect(err.code).toBe('wrong_chain');
    expect(err.message).toMatch(/Monad mainnet \(chain 143\).*Monad Testnet \(chain 10143\)/);
    expect(node.calls).toEqual([]);
  });

  it('says there is no wallet when there is none, here and in the client that stands in for one', async () => {
    const node = fakeNode();
    expect((await failure(clientWith(fakeWallet(), node, { hasWallet: false }).readWallet(MARKET))).code).toBe('no_wallet');
    const none = createViemSpotClient({ chain: monadTestnet, hasWallet: true, getSigner: async () => null, publicTransport: node.transport });
    expect((await failure(none.placeOrder(MARKET, order('buy', '83.272')))).code).toBe('no_wallet');
    const off = unavailableSpotClient({ chainId: 10143 });
    expect(off.availability().state).toBe('no_wallet');
    expect((await failure(off.readWallet(MARKET))).code).toBe('no_wallet');
    expect((await failure(off.mint(MARKET, 'quote', { atoms: '1', decimals: 6 }))).code).toBe('no_wallet');
    expect((await failure(off.placeOrder(MARKET, order('buy', '83.272')))).code).toBe('no_wallet');
    expect(node.calls).toEqual([]);
  });
});

describe('createViemSpotClient: a market buy', () => {
  const filled = { [TX_SECOND]: { logs: [tradeLog({ taker: ACCOUNT, price: 83_272n * ONE_MON, filled: 1_000_000n })] } };

  it('approves exactly what is spent, then sends the order fill-or-kill with no value, and reads the fill', async () => {
    const wallet = fakeWallet();
    // Short before the approval, enough once it is mined.
    const node = fakeNode({ allowances: { quote: [0n, 83_272_000n] }, receipts: filled });
    const steps: SpotStep[] = [];
    const receipt = await clientWith(wallet, node).placeOrder(MARKET, order('buy', '83.272'), (s) => steps.push(s));

    const [approve, placed] = wallet.sent();
    // approve(market, 83.272 USDC at the quote token's 6 decimals), on the quote token.
    expect(approve!.to.toLowerCase()).toBe(QUOTE.toLowerCase());
    expect(approve!.data.startsWith(APPROVE)).toBe(true);
    expect(decodeFunctionData({ abi: spotTokenAbi, data: approve!.data }).args).toEqual([BOOK, 83_272_000n]);
    // placeAndExecuteMarketBuy(832720 at the 4 price decimals, 0.00098703 tkBTC at the base 8 decimals, no margin, fill or kill).
    expect(placed!.to.toLowerCase()).toBe(BOOK.toLowerCase());
    expect(placed!.data.startsWith(MARKET_BUY)).toBe(true);
    expect(decodeFunctionData({ abi: kuruOrderBookAbi, data: placed!.data }).args).toEqual([832_720n, 98_703n, false, true]);
    expect(placed!.value === undefined || BigInt(placed!.value) === 0n).toBe(true);
    expect(placed!.from.toLowerCase()).toBe(ACCOUNT);
    expect(wallet.sent()).toHaveLength(2);

    expect(receipt).toEqual({
      txHash: TX_SECOND,
      approveTxHash: TX_FIRST,
      fill: {
        size: { atoms: '1000000', decimals: 9 },
        averagePrice: { atoms: (83_272n * ONE_MON).toString(), decimals: 18 },
        trades: 1,
      },
    });
    expect(steps).toEqual(['checking', 'approving', 'approval_pending', 'ordering', 'order_pending']);
    // The order was dry-run against the chain before the wallet was asked to sign it.
    expect(node.calls.indexOf('dry-run')).toBeGreaterThan(-1);
  });

  it('sends one transaction when the market may already move what the order spends', async () => {
    const wallet = fakeWallet();
    const node = fakeNode({
      allowances: { quote: [83_272_000n] },
      receipts: { [TX_FIRST]: { logs: [tradeLog({ taker: ACCOUNT, price: 83_272n * ONE_MON, filled: 1_000_000n })] } },
    });
    const steps: SpotStep[] = [];
    const receipt = await clientWith(wallet, node).placeOrder(MARKET, order('buy', '83.272'), (s) => steps.push(s));
    expect(wallet.sent()).toHaveLength(1);
    expect(wallet.sent()[0]!.data.startsWith(MARKET_BUY)).toBe(true);
    expect(receipt.txHash).toBe(TX_FIRST);
    expect(receipt.approveTxHash).toBeUndefined();
    expect(steps).toEqual(['checking', 'ordering', 'order_pending']);
  });

  it('counts only trades the market itself logged with this wallet as taker', async () => {
    const node = fakeNode({
      allowances: { quote: [83_272_000n] },
      receipts: {
        [TX_FIRST]: {
          logs: [
            tradeLog({ taker: ACCOUNT, price: 83_272n * ONE_MON, filled: 600_000n }),
            tradeLog({ taker: ACCOUNT, price: 83_300n * ONE_MON, filled: 400_000n }),
            // Someone else's trade in the same transaction, and a look-alike log from another contract.
            tradeLog({ taker: MAKER, price: 90_000n * ONE_MON, filled: 9_000_000n }),
            tradeLog({ taker: ACCOUNT, price: 1n * ONE_MON, filled: 9_000_000n, address: QUOTE }),
          ],
        },
      },
    });
    const receipt = await clientWith(fakeWallet(), node).placeOrder(MARKET, order('buy', '83.272'));
    expect(receipt.fill).toEqual({
      size: { atoms: '1000000', decimals: 9 },
      averagePrice: { atoms: '83283200000000000000000', decimals: 18 },
      trades: 2,
    });
  });

  it('reports no fill when the transaction succeeded and no trade names the wallet', async () => {
    const node = fakeNode({
      allowances: { quote: [83_272_000n] },
      receipts: { [TX_FIRST]: { logs: [tradeLog({ taker: MAKER, price: 83_272n * ONE_MON, filled: 1_000_000n })] } },
    });
    const receipt = await clientWith(fakeWallet(), node).placeOrder(MARKET, order('buy', '83.272'));
    expect(receipt).toEqual({ txHash: TX_FIRST, fill: null });
  });

  it('an order that cannot fill inside its bound reverts in the dry-run: said calmly, and nothing is signed', async () => {
    const wallet = fakeWallet();
    const node = fakeNode({ allowances: { quote: [83_272_000n] }, dryRun: 'reverts' });
    const err = await failure(clientWith(wallet, node).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('reverted');
    expect(err.message).toBe(REVERTED_LINE);
    expect(err.txHash).toBeUndefined();
    expect(wallet.sent()).toHaveLength(0);
  });

  it('a mined revert is the same bound, later, and carries its transaction', async () => {
    const node = fakeNode({ allowances: { quote: [83_272_000n] }, receipts: { [TX_FIRST]: { status: '0x0' } } });
    const err = await failure(clientWith(fakeWallet(), node).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('reverted');
    expect(err.message).toBe(REVERTED_LINE);
    expect(err.txHash).toBe(TX_FIRST);
  });

  it('a declined order is "rejected", and says nothing was traded', async () => {
    const node = fakeNode({ allowances: { quote: [83_272_000n] } });
    const err = await failure(clientWith(fakeWallet({ reject: true }), node).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('rejected');
    expect(err.message).toMatch(/Nothing was traded\.$/);
  });

  it('a declined approval stops there: the order is never sent', async () => {
    const wallet = fakeWallet({ reject: true });
    const err = await failure(clientWith(wallet, fakeNode()).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('rejected');
    expect(err.message).toBe('The approval was declined in the wallet. Nothing was traded.');
    expect(wallet.calls.filter((c) => c.method === 'eth_sendTransaction')).toHaveLength(1);
  });

  it('does not send the order while the approval does not show in the allowance', async () => {
    const wallet = fakeWallet();
    // Mined, but the node read next still answers with the old allowance.
    const node = fakeNode({ allowances: { quote: [0n] } });
    const err = await failure(clientWith(wallet, node).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('failed');
    expect(err.message).toMatch(/Nothing was traded/);
    expect(err.txHash).toBe(TX_FIRST);
    expect(wallet.sent()).toHaveLength(1);
    expect(node.calls).not.toContain('dry-run');
  });

  it('a reverted approval is not the bound: it says the approval reverted, with its transaction', async () => {
    const wallet = fakeWallet();
    const node = fakeNode({ receipts: { [TX_FIRST]: { status: '0x0' } } });
    const err = await failure(clientWith(wallet, node).placeOrder(MARKET, order('buy', '83.272')));
    expect(err).toMatchObject({ code: 'failed', message: 'The approval reverted. Nothing was traded.', txHash: TX_FIRST });
    expect(wallet.sent()).toHaveLength(1);
  });

  it('asks nothing of a wallet that cannot pay for gas', async () => {
    const wallet = fakeWallet();
    const err = await failure(clientWith(wallet, fakeNode({ gas: 0n })).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('no_gas');
    expect(err.message).toMatch(/no testnet MON/);
    expect(wallet.calls).toEqual([]);
  });

  it('does not send from a wallet that is on another network and cannot be moved', async () => {
    const wallet = fakeWallet({ chainId: 143, cannotSwitch: true });
    const node = fakeNode({ allowances: { quote: [83_272_000n] } });
    const err = await failure(clientWith(wallet, node).placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('wrong_chain');
    expect(err.message).toBe('The wallet is on another network. Switch it to Monad Testnet (chain 10143) and send again. Nothing was sent.');
    expect(wallet.sent()).toHaveLength(0);
  });

  it('an order whose receipt cannot be read is said to have been sent, with its hash, never "try again"', async () => {
    const node = fakeNode({ allowances: { quote: [83_272_000n] }, receipts: { [TX_FIRST]: 'missing' } });
    // The wait is cut short here; in the app it is a minute.
    const client = clientWith(fakeWallet(), node, { receiptTimeoutMs: 40 });
    const err = await failure(client.placeOrder(MARKET, order('buy', '83.272')));
    expect(err.code).toBe('unconfirmed');
    expect(err.txHash).toBe(TX_FIRST);
    expect(err.message).toMatch(/It may have filled/);
  });
});

describe('createViemSpotClient: a market sell', () => {
  it('approves the base token and sends the size at the size decimals, with the least quote accepted', async () => {
    const wallet = fakeWallet();
    const node = fakeNode({
      allowances: { base: [0n, 100_000n] },
      receipts: { [TX_SECOND]: { logs: [tradeLog({ taker: ACCOUNT, price: 82_447n * ONE_MON, filled: 1_000_000n })] } },
    });
    const receipt = await clientWith(wallet, node).placeOrder(MARKET, order('sell', '0.001'));
    const [approve, placed] = wallet.sent();
    // approve(market, 0.001 tkBTC at the base token's 8 decimals), on the base token.
    expect(approve!.to.toLowerCase()).toBe(BASE.toLowerCase());
    expect(decodeFunctionData({ abi: spotTokenAbi, data: approve!.data }).args).toEqual([BOOK, 100_000n]);
    // placeAndExecuteMarketSell(0.001 at the 9 size decimals, 81.378180 USDC at the quote 6 decimals, no margin, fill or kill).
    expect(placed!.data.startsWith(MARKET_SELL)).toBe(true);
    expect(decodeFunctionData({ abi: kuruOrderBookAbi, data: placed!.data }).args).toEqual([1_000_000n, 81_378_180n, false, true]);
    expect(receipt.fill?.size).toEqual({ atoms: '1000000', decimals: 9 });
  });
});

describe('createViemSpotClient: the open mint', () => {
  it('mints test USDC to the signing wallet, from the quote token', async () => {
    const wallet = fakeWallet();
    const out = await clientWith(wallet, fakeNode()).mint(MARKET, 'quote', { atoms: '1000000000', decimals: 6 });
    expect(out).toEqual({ txHash: TX_FIRST });
    const [sent] = wallet.sent();
    expect(sent!.to.toLowerCase()).toBe(QUOTE.toLowerCase());
    expect(sent!.data.startsWith(MINT)).toBe(true);
    const [to, amount] = decodeFunctionData({ abi: spotTokenAbi, data: sent!.data }).args as [string, bigint];
    expect(to.toLowerCase()).toBe(ACCOUNT);
    expect(amount).toBe(1_000_000_000n);
  });

  it('says nothing was minted when the mint is declined, reverts, or the wallet has no gas', async () => {
    const amount = { atoms: '1000000000', decimals: 6 };
    const declined = await failure(clientWith(fakeWallet({ reject: true }), fakeNode()).mint(MARKET, 'quote', amount));
    expect(declined).toMatchObject({ code: 'rejected', message: 'The request was declined in the wallet. Nothing was minted.' });
    const reverted = await failure(
      clientWith(fakeWallet(), fakeNode({ receipts: { [TX_FIRST]: { status: '0x0' } } })).mint(MARKET, 'quote', amount),
    );
    expect(reverted).toMatchObject({ code: 'failed', message: 'The mint reverted. Nothing was minted.', txHash: TX_FIRST });
    const wallet = fakeWallet();
    const dry = await failure(clientWith(wallet, fakeNode({ gas: 0n })).mint(MARKET, 'quote', amount));
    expect(dry.code).toBe('no_gas');
    expect(wallet.calls).toEqual([]);
  });
});
