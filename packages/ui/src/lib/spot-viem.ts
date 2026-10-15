/**
 * `SpotClient` over viem, for the market Kanon listed on Kuru's testnet.
 *
 * The signer is injected as an EIP-1193 provider, exactly as for pinning: the
 * Privy embedded wallet's on the web, `@privy-io/expo`'s on a phone. This file
 * knows neither. Every call below is made from the person's own wallet.
 *
 * It does no arithmetic. The amounts it sends are the ones `spot.ts` worked
 * out, and the fill it reports is the one `spot.ts` reads from the receipt's
 * decoded logs. What is here is the order of the calls and the honest wording
 * of each way they can stop.
 *
 * The two ABIs are the human-readable form of the calls the listing was
 * rehearsed with: the ERC-20 surface of both test tokens (each has an open
 * `mint`), and the three members of Kuru's OrderBook this screen uses.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseEventLogs,
  type Chain,
  type Hex,
  type TransactionReceipt,
  type Transport,
} from 'viem';
import type { Signer } from './pin-viem';
import {
  REVERTED_LINE,
  SPOT_NO_WALLET,
  SPOT_WALLET_UNREAD,
  noGasLine,
  summariseFill,
  wrongChainLine,
  type SpotMarket,
  type SpotStep,
} from './spot';
import { SpotError, spotAvailability, type SpotClient } from './spot-client';

export const spotTokenAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);

export const kuruOrderBookAbi = parseAbi([
  'function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
  'function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
  'event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)',
]);

export interface ViemSpotClientOptions {
  chain: Chain;
  /** Whether a wallet exists at all. Drives the availability message before anything is read. */
  hasWallet: boolean;
  /** Resolves the signer at the moment of use, so a wallet created after login is picked up. */
  getSigner: () => Promise<Signer | null>;
  /** How reads and receipts reach the chain. Defaults to the chain's own public RPC; tests inject one. */
  publicTransport?: Transport;
  /** How long a receipt is waited for before the transaction is reported as sent and not confirmed. */
  receiptTimeoutMs?: number;
}

/** Monad mines in under a second. A receipt not read after this long is said to be unread, with its hash. */
export const RECEIPT_TIMEOUT_MS = 60_000;

/** Which of the three transactions a failure happened in: the wording differs, and only an order's revert is the bound. */
type During = 'mint' | 'approve' | 'order';

const NOT_SENT: Record<During, string> = {
  mint: 'The mint could not be sent. Nothing was minted.',
  approve: 'The approval could not be sent. Nothing was traded.',
  order: 'The order could not be sent. Nothing was traded.',
};
const DECLINED: Record<During, string> = {
  mint: 'The request was declined in the wallet. Nothing was minted.',
  approve: 'The approval was declined in the wallet. Nothing was traded.',
  order: 'The order was declined in the wallet. Nothing was traded.',
};
const REFUSED: Record<During, string> = {
  mint: 'The token refused the mint. Nothing was minted.',
  approve: 'The token refused the approval. Nothing was traded.',
  order: REVERTED_LINE,
};
const UNCONFIRMED: Record<During, string> = {
  mint: 'The mint was sent, but its receipt could not be read. Open the transaction before minting again.',
  approve: 'The approval was sent, but its receipt could not be read. Nothing was traded. Open the transaction, then send the order again.',
  order: 'The order was sent, but its receipt could not be read. It may have filled. Open the transaction before sending another.',
};

type Thrown = { name?: string; code?: number; shortMessage?: string; message?: string; details?: string; cause?: unknown };

/** An error and its causes: viem wraps the wallet's or the node's own error a few layers deep. */
function layers(err: unknown): Thrown[] {
  const out: Thrown[] = [];
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    out.push(current as Thrown);
    current = (current as Thrown).cause;
  }
  return out;
}

function asAddress(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new SpotError('failed', 'The market named a contract address that is not one. Nothing was sent.');
  }
  return value as `0x${string}`;
}

export function createViemSpotClient(opts: ViemSpotClientOptions): SpotClient {
  const { chain } = opts;
  const publicClient = createPublicClient({ chain, transport: opts.publicTransport ?? http() });
  const availability = () => spotAvailability({ hasWallet: opts.hasWallet });

  /** Maps whatever the wallet or the node threw to a code the screen can word honestly. */
  function toSpotError(err: unknown, during: During): SpotError {
    if (err instanceof SpotError) return err;
    const all = layers(err);
    const said = all.map((e) => `${e.shortMessage ?? ''} ${e.details ?? ''} ${e.message ?? ''}`).join(' ');
    if (all.some((e) => e.name === 'UserRejectedRequestError' || e.code === 4001)) {
      return new SpotError('rejected', DECLINED[during]);
    }
    if (all.some((e) => e.name === 'ChainMismatchError')) {
      return new SpotError(
        'wrong_chain',
        `The wallet is on another network. Switch it to ${chain.name} (chain ${chain.id}) and send again. Nothing was sent.`,
      );
    }
    if (all.some((e) => e.name === 'InsufficientFundsError') || /insufficient funds/i.test(said)) {
      return new SpotError('no_gas', `The wallet could not pay for gas. ${noGasLine(chain.nativeCurrency.symbol)}`);
    }
    if (
      all.some((e) => e.name === 'ContractFunctionRevertedError' || e.name === 'ExecutionRevertedError') ||
      /execution reverted/i.test(said)
    ) {
      return new SpotError(during === 'order' ? 'reverted' : 'failed', REFUSED[during]);
    }
    return new SpotError('failed', NOT_SENT[during]);
  }

  /** The signer for a market this client can trade: a wallet exists, and the market is on this client's chain. */
  async function signerFor(market: SpotMarket): Promise<Signer> {
    if (availability().state !== 'ready') throw new SpotError('no_wallet', SPOT_NO_WALLET);
    if (market.chainId !== chain.id) throw new SpotError('wrong_chain', wrongChainLine(market.chainId, chain.id));
    const signer = await opts.getSigner();
    if (!signer) throw new SpotError('no_wallet', SPOT_NO_WALLET);
    return signer;
  }

  async function walletFor(signer: Signer) {
    const wallet = createWalletClient({ account: signer.address, chain, transport: custom(signer.provider) });
    // An embedded wallet may still be pointed at another chain. Ask it to move; if it
    // cannot, the write below fails with the chain named rather than sending elsewhere.
    try {
      await wallet.switchChain({ id: chain.id });
    } catch {
      /* the write will surface a wrong-chain error */
    }
    return wallet;
  }

  /** Nothing is asked of the wallet when it cannot pay for the transaction. */
  async function requireGas(account: `0x${string}`): Promise<void> {
    const wei = await publicClient.getBalance({ address: account });
    if (wei <= BigInt(0)) throw new SpotError('no_gas', noGasLine(chain.nativeCurrency.symbol));
  }

  /**
   * Sends one call and waits for its receipt. Once a hash has come back it is
   * never dropped: a receipt that cannot be read is reported with the hash, so
   * the person can look before sending anything again.
   */
  async function send(
    wallet: Awaited<ReturnType<typeof walletFor>>,
    account: `0x${string}`,
    request: { address: `0x${string}`; abi: unknown; functionName: string; args: readonly unknown[] },
    during: During,
    onSent?: () => void,
  ): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    let hash: Hex;
    try {
      hash = await wallet.writeContract({ ...request, account, chain } as never);
    } catch (err) {
      throw toSpotError(err, during);
    }
    onSent?.();
    try {
      const timeout = opts.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
      return { hash, receipt: await publicClient.waitForTransactionReceipt({ hash, timeout }) };
    } catch {
      throw new SpotError('unconfirmed', UNCONFIRMED[during], hash, during);
    }
  }

  return {
    chainId: chain.id,
    availability,

    async readWallet(market) {
      const signer = await signerFor(market);
      const account = signer.address;
      const book = asAddress(market.market);
      const base = asAddress(market.base.address);
      const quote = asAddress(market.quote.address);
      const read = (address: `0x${string}`, functionName: 'balanceOf' | 'allowance', args: readonly `0x${string}`[]) =>
        publicClient.readContract({ address, abi: spotTokenAbi, functionName, args } as never) as Promise<bigint>;
      try {
        const [native, baseBalance, quoteBalance, baseAllowance, quoteAllowance] = await Promise.all([
          publicClient.getBalance({ address: account }),
          read(base, 'balanceOf', [account]),
          read(quote, 'balanceOf', [account]),
          read(base, 'allowance', [account, book]),
          read(quote, 'allowance', [account, book]),
        ]);
        return {
          address: account,
          native: { atoms: native.toString(), decimals: chain.nativeCurrency.decimals },
          nativeSymbol: chain.nativeCurrency.symbol,
          base: { atoms: baseBalance.toString(), decimals: market.base.decimals },
          quote: { atoms: quoteBalance.toString(), decimals: market.quote.decimals },
          baseAllowance: { atoms: baseAllowance.toString(), decimals: market.base.decimals },
          quoteAllowance: { atoms: quoteAllowance.toString(), decimals: market.quote.decimals },
        };
      } catch {
        throw new SpotError('failed', SPOT_WALLET_UNREAD);
      }
    },

    async mint(market, which, amount) {
      const signer = await signerFor(market);
      const account = signer.address;
      const token = asAddress(which === 'base' ? market.base.address : market.quote.address);
      try {
        await requireGas(account);
      } catch (err) {
        throw toSpotError(err, 'mint');
      }
      const wallet = await walletFor(signer);
      const { hash, receipt } = await send(
        wallet,
        account,
        { address: token, abi: spotTokenAbi, functionName: 'mint', args: [account, BigInt(amount.atoms)] },
        'mint',
      );
      if (receipt.status !== 'success') throw new SpotError('failed', 'The mint reverted. Nothing was minted.', hash, 'mint');
      return { txHash: hash };
    },

    async placeOrder(market, order, onStep) {
      const step = (next: SpotStep) => onStep?.(next);
      step('checking');
      const signer = await signerFor(market);
      const account = signer.address;
      const book = asAddress(market.market);
      const spent = asAddress(order.spendToken.address);
      const spend = BigInt(order.spend.atoms);
      const sizeArg = BigInt(order.sizeArg.atoms);
      const minOut = BigInt(order.minOut.atoms);
      if (spend <= BigInt(0) || sizeArg <= BigInt(0) || minOut <= BigInt(0)) {
        throw new SpotError('failed', 'The order has no size or no bound. Nothing was sent.');
      }

      const allowanceOf = () =>
        publicClient.readContract({ address: spent, abi: spotTokenAbi, functionName: 'allowance', args: [account, book] });
      let allowance: bigint;
      try {
        await requireGas(account);
        allowance = await allowanceOf();
      } catch (err) {
        throw toSpotError(err, 'order');
      }

      const wallet = await walletFor(signer);

      // Approve exactly what the order spends, and only when the market may not already move it.
      let approveTxHash: Hex | undefined;
      if (allowance < spend) {
        step('approving');
        const approval = await send(
          wallet,
          account,
          { address: spent, abi: spotTokenAbi, functionName: 'approve', args: [book, spend] },
          'approve',
          () => step('approval_pending'),
        );
        if (approval.receipt.status !== 'success') {
          throw new SpotError('failed', 'The approval reverted. Nothing was traded.', approval.hash, 'approve');
        }
        approveTxHash = approval.hash;
        // The node asked next may be a block behind the one that mined the approval. An order
        // dry-run against the old allowance would revert and be mistaken for the bound.
        let seen: bigint;
        try {
          seen = await allowanceOf();
        } catch (err) {
          throw toSpotError(err, 'order');
        }
        if (seen < spend) {
          throw new SpotError(
            'failed',
            'The approval was mined, but the allowance does not show it yet. Nothing was traded. Send the order again in a moment.',
            approval.hash,
            'approve',
          );
        }
      }

      // Never margin, always fill or kill, no value: a spot order from the wallet's own tokens.
      const call = {
        address: book,
        abi: kuruOrderBookAbi,
        functionName: order.side === 'buy' ? 'placeAndExecuteMarketBuy' : 'placeAndExecuteMarketSell',
        args: [sizeArg, minOut, false, true],
      } as const;

      // Dry-run the exact call. An order that cannot fill inside its bound reverts here,
      // before anything is signed, instead of as a mined transaction that spent gas to say so.
      try {
        await publicClient.simulateContract({ ...call, account } as never);
      } catch (err) {
        throw toSpotError(err, 'order');
      }

      step('ordering');
      const sent = await send(wallet, account, call, 'order', () => step('order_pending'));
      // The book can move between the dry-run and the block: a mined revert is the same bound, later.
      if (sent.receipt.status !== 'success') throw new SpotError('reverted', REVERTED_LINE, sent.hash, 'order');

      // The fill is what the market itself logged for this wallet. Logs from any other
      // address, or naming any other taker, are not this order's.
      const trades = parseEventLogs({ abi: kuruOrderBookAbi, logs: sent.receipt.logs, eventName: 'Trade' })
        .filter((log) => log.address.toLowerCase() === book.toLowerCase())
        .map((log) => ({
          takerAddress: log.args.takerAddress,
          price: log.args.price,
          filledSize: log.args.filledSize,
        }));

      return {
        txHash: sent.hash,
        ...(approveTxHash ? { approveTxHash } : {}),
        fill: summariseFill(trades, account, market.sizeDecimals),
      };
    },
  };
}
