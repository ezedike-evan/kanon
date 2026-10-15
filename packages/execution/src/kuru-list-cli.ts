/**
 * Lists one new spot market on Kuru's testnet order book, seeds it, and fills
 * one order against it through `KuruClient`.
 *
 *   pnpm --filter @kanon/execution kuru:list --price 83000            look only: the account, the plan, a simulated listing
 *   pnpm --filter @kanon/execution kuru:list --price 83000 --send     send it: token, market, liquidity, one buy
 *
 * What it lists, said plainly. Kuru's testnet lists MON/USDC and nothing else.
 * This adds tkBTC/USDC, where:
 *
 *   - tkBTC ("Kanon Test BTC") is a test token this script deploys. It is the
 *     `MockERC20` from `packages/contracts`, and anybody can mint it. It is not
 *     bitcoin, it is not backed by bitcoin, and it has no value.
 *   - USDC is Kanon's own "Mock USDC" on testnet (`CollateralToken` in
 *     `packages/contracts/deployments/10143.json`), which anybody can mint too.
 *
 * `--price` is the dollar price the market opens at. It is the only number in
 * the listing that comes from outside: everything else is derived from it by
 * Kuru's own `calculatePrecisions`, printed before anything is sent, and read
 * back from the chain after.
 *
 * Testnet only: it refuses any chain other than 10143.
 *
 * It signs with the testnet deployer key, read from `packages/contracts/.env`
 * (gitignored) as `PRIVATE_KEY`. The key is never printed. A run is recorded,
 * step by step, in `packages/execution/kuru-listing.testnet.json`: addresses,
 * parameters and transaction hashes, nothing secret. A second run reads that
 * file and continues from the step the first one stopped at, so no step is
 * ever sent twice.
 *
 * `--rpc <url>` and `--record <path>` point it at a local fork for a rehearsal
 * (`anvil --fork-url https://testnet-rpc.monad.xyz --chain-id 10143`), with
 * `KURU_LIST_PRIVATE_KEY` as the key in place of the deployer's.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ethers as Ethers } from 'ethers';
import { parseDecimal } from '@kanon/spec';
import { KURU_CONTRACTS, KURU_NETWORK, KuruClient, createKuruSdkAdapter, loadKuruSdk } from './kuru';
import { toPlainString } from './scaling';

/**
 * ethers v5 ships two builds. An `import` under a bundler's resolver picks the
 * one made for browsers, whose HTTP client calls `fetch` with a `referrer` Node
 * rejects, so every RPC call fails with "missing response". `require` picks the
 * Node build, the same one the Kuru SDK itself loads.
 */
const { ethers } = createRequire(import.meta.url)('ethers') as { ethers: typeof Ethers };

const NETWORK = 'testnet' as const;
const CHAIN_ID = KURU_NETWORK[NETWORK].chainId;
const ROUTER = KURU_CONTRACTS[NETWORK].router;
const EXPLORER = 'https://testnet.monadscan.com';
const ASSET = 'tkBTC/USDC';

/** Kanon's Mock USDC on testnet: `CollateralToken` in `packages/contracts/deployments/10143.json`. */
const QUOTE = '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C';
const BASE = { name: 'Kanon Test BTC', symbol: 'tkBTC', decimals: 8 } as const;

/** Two ERC-20s. Kuru's market types: 0 two tokens, 1 native MON as base, 2 native MON as quote. */
const MARKET_TYPE = 0;
/** Kuru's own example values (`examples/v2/createMarket.ts`): 0.30% taker, 0.10% maker, a 1.00% AMM spread. */
const TAKER_FEE_BPS = 30;
const MAKER_FEE_BPS = 10;
const AMM_SPREAD_BPS = 100;
/** The smallest order, in tkBTC, and the tick, in basis points of the opening price. */
const MIN_SIZE = 0.0001;
const TICK_BPS = 1;
/** What the market is seeded with, in tkBTC. The USDC side is this at the opening price. */
const SEED_BASE = '50';
/** The one order: a market buy of this much tkBTC, refused if it would fill more than this far from the best ask. */
const ORDER_BASE = '0.001';
const ORDER_MAX_SLIPPAGE_BPS = 200;

const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function mint(address to, uint256 amount)',
];
const ROUTER_EVENTS = new ethers.utils.Interface([
  'event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)',
]);

const args = process.argv.slice(2).filter((a) => a !== '--');
const has = (name: string) => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

function stop(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

const tx = (hash: string) => `${EXPLORER}/tx/${hash}`;
const address = (a: string) => `${EXPLORER}/address/${a}`;

/** What a run has done so far. Public facts only. */
interface ListingRecord {
  network: typeof NETWORK;
  chainId: number;
  asset: typeof ASSET;
  note: string;
  openingPriceUsd?: number;
  base?: { address: string; name: string; symbol: string; decimals: number; kind: string; deployTx: string };
  quote?: { address: string; name: string; symbol: string; decimals: number; kind: string };
  market?: {
    address: string;
    vault: string;
    router: string;
    type: number;
    deployTx: string;
    /** As read back from the chain after the listing. */
    pricePrecision: string;
    sizePrecision: string;
    tickSize: string;
    minSize: string;
    maxSize: string;
    takerFeeBps: string;
    makerFeeBps: string;
    ammSpreadBps: string;
  };
  liquidity?: { base: string; quote: string; tx: string };
  order?: { side: 'buy'; size: string; tx: string; filledSize: string; avgFillPrice: string };
}

const NOTE =
  'tkBTC is a test token with an open mint, deployed by Kanon. It is not bitcoin and has no value. USDC here is Kanon\'s Mock USDC on Monad testnet, also with an open mint.';

async function main() {
  // This repo is developed on a link with broken IPv6; harmless elsewhere.
  if (process.env.FORCE_IPV4 === 'true') {
    setDefaultResultOrder('ipv4first');
    setDefaultAutoSelectFamily(false);
  }

  const price = Number(option('price'));
  if (!Number.isFinite(price) || price <= 0) stop('Give the opening price in dollars: --price 83000');
  const rpcUrl = option('rpc') ?? KURU_NETWORK[NETWORK].rpcUrl;
  const rehearsal = rpcUrl !== KURU_NETWORK[NETWORK].rpcUrl;
  const recordPath = resolve(option('record') ?? 'kuru-listing.testnet.json');
  if (rehearsal && !option('record')) stop('A rehearsal on another RPC needs its own --record path, so it cannot be mistaken for the real listing.');

  const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, CHAIN_ID);
  const chain = await provider.send('eth_chainId', []);
  if (Number(BigInt(chain as string)) !== CHAIN_ID) stop(`This script lists on chain ${CHAIN_ID} only. The RPC answered ${String(chain)}.`);

  const record: ListingRecord = existsSync(recordPath)
    ? (JSON.parse(readFileSync(recordPath, 'utf8')) as ListingRecord)
    : { network: NETWORK, chainId: CHAIN_ID, asset: ASSET, note: NOTE };
  const save = () => writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  if (record.openingPriceUsd !== undefined && record.openingPriceUsd !== price) {
    stop(`This listing was started at $${record.openingPriceUsd}. Run it again with --price ${record.openingPriceUsd}.`);
  }

  const sdk = await loadKuruSdk();
  const creator = new sdk.ParamCreator();
  const precisions = creator.calculatePrecisions(price, 1, price * 10, MIN_SIZE, TICK_BPS);
  const deployerAddress = process.env.DEPLOYER;

  console.log(`\nKuru ${NETWORK}${rehearsal ? ' (REHEARSAL on ' + rpcUrl + ')' : ''}`);
  console.log(`  market         ${ASSET}  (${BASE.name}, a test token with an open mint, against Kanon's Mock USDC)`);
  console.log(`  opening price  $${price}`);
  console.log(`  precision      price 1/${precisions.pricePrecision.toString()}, size 1/${precisions.sizePrecision.toString()} tkBTC`);
  console.log(`  tick           ${precisions.tickSize.toString()} / ${precisions.pricePrecision.toString()} dollars`);
  console.log(`  order size     ${precisions.minSize.toString()} to ${precisions.maxSize.toString()}, in 1/${precisions.sizePrecision.toString()} tkBTC`);
  console.log(`  fees           taker ${TAKER_FEE_BPS} bps, maker ${MAKER_FEE_BPS} bps, AMM spread ${AMM_SPREAD_BPS} bps`);
  console.log(`  seed           ${SEED_BASE} tkBTC and its value in USDC at the opening price`);
  console.log(`  then           one market buy of ${ORDER_BASE} tkBTC through KuruClient`);

  if (!has('send')) {
    // Look only. The listing is simulated with a call, from the deployer's address when it is known.
    const from = deployerAddress && ethers.utils.isAddress(deployerAddress) ? deployerAddress : ethers.constants.AddressZero;
    const balance = await provider.getBalance(from);
    console.log(`\n  account        ${from}  ${ethers.utils.formatEther(balance)} MON`);
    try {
      const request = await sdk.ParamCreator.constructDeployMarketTransaction(
        new ethers.VoidSigner(from, provider),
        ROUTER,
        MARKET_TYPE,
        // Any token stands in for tkBTC in the simulation: it does not exist until this is sent.
        record.base?.address ?? '0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570',
        QUOTE,
        precisions.sizePrecision,
        precisions.pricePrecision,
        precisions.tickSize,
        precisions.minSize,
        precisions.maxSize,
        TAKER_FEE_BPS,
        MAKER_FEE_BPS,
        ethers.BigNumber.from(AMM_SPREAD_BPS),
      );
      const out = await provider.call({ from, to: request.to!, data: request.data! });
      console.log(`  simulation     the router accepts the listing (it would return ${ethers.utils.defaultAbiCoder.decode(['address'], out)[0] as string})`);
    } catch (err) {
      console.log(`  simulation     the router refused the listing: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
    console.log('\nNothing was sent. Add --send to list it.');
    return;
  }

  const envKey = rehearsal ? process.env.KURU_LIST_PRIVATE_KEY : process.env.PRIVATE_KEY;
  if (!envKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(envKey)) {
    stop(rehearsal ? 'Set KURU_LIST_PRIVATE_KEY to the rehearsal key.' : 'PRIVATE_KEY was not found in packages/contracts/.env.');
  }
  const signer = new ethers.Wallet(envKey.startsWith('0x') ? envKey : `0x${envKey}`, provider);
  const me = await signer.getAddress();
  const balance = await provider.getBalance(me);
  console.log(`\n  account        ${me}  ${ethers.utils.formatEther(balance)} MON`);
  if (balance.lt(ethers.utils.parseEther('1'))) stop('The account holds under 1 MON. Listing costs gas for six transactions: fund it first.');

  record.openingPriceUsd = price;
  save();

  // 1. The test token.
  if (!record.base) {
    const artifactPath = resolve('../contracts/out/MockERC20.sol/MockERC20.json');
    if (!existsSync(artifactPath)) stop('MockERC20 is not built. Run `forge build` in packages/contracts first.');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: Ethers.ContractInterface; bytecode: { object: string } };
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
    const token = await factory.deploy(BASE.name, BASE.symbol, BASE.decimals);
    await token.deployed();
    record.base = { address: token.address, ...BASE, kind: 'test token, open mint', deployTx: token.deployTransaction.hash };
    save();
    console.log(`\n1. token deployed    ${token.address}\n   ${tx(token.deployTransaction.hash)}`);
  } else {
    console.log(`\n1. token (earlier)   ${record.base.address}`);
  }
  const base = new ethers.Contract(record.base.address, TOKEN_ABI, signer);
  const quote = new ethers.Contract(QUOTE, TOKEN_ABI, signer);
  if (!record.quote) {
    record.quote = {
      address: QUOTE,
      name: (await quote.name()) as string,
      symbol: (await quote.symbol()) as string,
      decimals: Number(await quote.decimals()),
      kind: "Kanon's mock collateral token, open mint",
    };
    save();
  }
  const quoteDecimals = record.quote.decimals;

  // 2. The market.
  if (!record.market) {
    const request = await sdk.ParamCreator.constructDeployMarketTransaction(
      signer,
      ROUTER,
      MARKET_TYPE,
      record.base.address,
      QUOTE,
      precisions.sizePrecision,
      precisions.pricePrecision,
      precisions.tickSize,
      precisions.minSize,
      precisions.maxSize,
      TAKER_FEE_BPS,
      MAKER_FEE_BPS,
      ethers.BigNumber.from(AMM_SPREAD_BPS),
    );
    const sent = await signer.sendTransaction(request);
    const receipt = await sent.wait(1);
    let registered: Ethers.utils.LogDescription | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ROUTER.toLowerCase()) continue;
      try {
        registered = ROUTER_EVENTS.parseLog(log);
        break;
      } catch {
        // Another of the router's events.
      }
    }
    if (!registered) stop(`The listing transaction succeeded but carries no MarketRegistered event: ${tx(receipt.transactionHash)}`);
    const market = registered.args.market as string;

    // Read back from the chain: what is recorded is what the market says of itself, not what was asked for.
    const params = await sdk.ParamFetcher.getMarketParams(provider, market);
    const vault = await sdk.VaultParamFetcher.getVaultParams(provider, market);
    if (params.baseAssetAddress.toLowerCase() !== record.base.address.toLowerCase() || params.quoteAssetAddress.toLowerCase() !== QUOTE.toLowerCase()) {
      stop(`The market at ${market} does not pair the two tokens that were asked for.`);
    }
    record.market = {
      address: market,
      vault: vault.kuruAmmVault,
      router: ROUTER,
      type: MARKET_TYPE,
      deployTx: receipt.transactionHash,
      pricePrecision: params.pricePrecision.toString(),
      sizePrecision: params.sizePrecision.toString(),
      tickSize: params.tickSize.toString(),
      minSize: params.minSize.toString(),
      maxSize: params.maxSize.toString(),
      takerFeeBps: params.takerFeeBps.toString(),
      makerFeeBps: params.makerFeeBps.toString(),
      ammSpreadBps: vault.spread.toString(),
    };
    save();
    console.log(`2. market listed     ${market}\n   ${tx(receipt.transactionHash)}`);
  } else {
    console.log(`2. market (earlier)  ${record.market.address}`);
  }
  const market = record.market.address;

  // 3. Liquidity: both tokens are test tokens anybody can mint, so the account mints what it deposits.
  if (!record.liquidity) {
    const baseAtoms = ethers.utils.parseUnits(SEED_BASE, BASE.decimals);
    const quoteAtoms = ethers.utils.parseUnits((Number(SEED_BASE) * price).toFixed(0), quoteDecimals);
    // Twice the seed of USDC: the rest pays for the order below.
    await (await base.mint(me, baseAtoms)).wait(1);
    await (await quote.mint(me, quoteAtoms.mul(2))).wait(1);
    const receipt = await sdk.Vault.depositWithAmounts(baseAtoms, quoteAtoms, record.base.address, QUOTE, record.market.vault, signer, true);
    record.liquidity = { base: SEED_BASE, quote: ethers.utils.formatUnits(quoteAtoms, quoteDecimals), tx: receipt.transactionHash };
    save();
    console.log(`3. liquidity seeded  ${SEED_BASE} tkBTC and ${record.liquidity.quote} USDC\n   ${tx(receipt.transactionHash)}`);
  } else {
    console.log(`3. liquidity (earlier) ${record.liquidity.base} tkBTC and ${record.liquidity.quote} USDC`);
  }

  // 4. One order, through the same client the app's venue router builds.
  const adapter = createKuruSdkAdapter({
    sdk,
    provider,
    signer,
    marginAccountAddress: KURU_CONTRACTS[NETWORK].marginAccount,
    // From the wallet, not from a margin account: the wallet approves the market and pays.
    useMargin: false,
  });
  const info = await adapter.getMarketInfo(market);
  const book = await adapter.getBestBidAsk(market, info);
  console.log(`\n   book               bid ${book.bid ? toPlainString(book.bid) : 'none'}  ask ${book.ask ? toPlainString(book.ask) : 'none'}`);

  if (!record.order) {
    const client = new KuruClient({ network: NETWORK, adapter, markets: { [ASSET]: market } });
    const before = (await base.balanceOf(me)) as Ethers.BigNumber;
    const result = await client.placeOrder({
      clientOrderId: `kuru-list-${Date.now()}`,
      asset: ASSET,
      side: 'buy',
      kind: 'market',
      size: parseDecimal(ORDER_BASE, BASE.decimals),
      maxSlippageBps: ORDER_MAX_SLIPPAGE_BPS,
    });
    if (result.status !== 'filled' || !result.filledSize || !result.avgFillPrice || !result.venueOrderId) {
      stop(`The order did not fill: ${result.status}${result.reason ? ` (${result.reason})` : ''}. The market and its liquidity stand; run this again to retry the order.`);
    }
    const after = (await base.balanceOf(me)) as Ethers.BigNumber;
    record.order = {
      side: 'buy',
      size: ORDER_BASE,
      tx: result.venueOrderId,
      filledSize: toPlainString(result.filledSize),
      avgFillPrice: toPlainString(result.avgFillPrice),
    };
    save();
    console.log(`4. order filled      bought ${record.order.filledSize} tkBTC at ${record.order.avgFillPrice}\n   ${tx(result.venueOrderId)}`);
    console.log(`   wallet tkBTC       ${ethers.utils.formatUnits(before, BASE.decimals)} -> ${ethers.utils.formatUnits(after, BASE.decimals)}`);
  } else {
    console.log(`4. order (earlier)   bought ${record.order.filledSize} tkBTC at ${record.order.avgFillPrice}`);
  }

  console.log(`\nDone. Recorded in ${recordPath}`);
  console.log(`  market  ${address(market)}`);
  console.log(`  token   ${address(record.base.address)}`);
}

main().catch((err: unknown) => {
  // The message only: an ethers error can carry the transaction it tried to sign.
  console.error(`\nStopped: ${err instanceof Error ? err.message.slice(0, 600) : String(err)}`);
  process.exit(1);
});
