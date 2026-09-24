/**
 * Testnet price mirror entry point. See `mirror.ts` for what it is and why.
 *
 *   PRIVATE_KEY=0x... pnpm --filter @kanon/relayer mirror -- --once
 *   PRIVATE_KEY=0x... pnpm --filter @kanon/relayer mirror              (loops)
 *
 * Each pass, per feed: read the mainnet Pyth price, write it to the testnet
 * MockPyth, then call `recordSample()` on the matching CanonicalSeries when its
 * cadence has elapsed. Addresses come from `deployments/10143.json`.
 *
 * Env (all optional except PRIVATE_KEY)
 *   DEPLOYMENT_FILE                default ../contracts/deployments/10143.json
 *   TESTNET_RPC_URL                default https://testnet-rpc.monad.xyz
 *   MAINNET_RPC_URL                default https://rpc.monad.xyz
 *   MIRROR_INTERVAL_SECONDS        default 300
 *   MIRROR_MAX_SOURCE_AGE_SECONDS  default 7200
 *
 * Gas: every pass sends up to four transactions (two `setPrice`, two
 * `recordSample`). At Monad testnet's ~200 gwei that is roughly 0.1 MON, so the
 * default 5-minute interval costs on the order of 1 MON an hour.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FEEDS, MAINNET_PYTH, mockPythAbi, planMirror, sourcePythAbi, type FeedName } from './mirror';

const seriesAbi = parseAbi([
  'function cadenceSeconds() view returns (uint256)',
  'function lastSampleTimestamp() view returns (uint256)',
  'function recordSample()',
]);

const DEPLOYMENT_KEYS: Record<FeedName, string> = {
  'BTC/USD': 'CanonicalSeriesBTCUSD',
  'ETH/USD': 'CanonicalSeriesETHUSD',
};

function need(name: string, v: string | undefined): string {
  if (!v) {
    console.error(`mirror: ${name} is required`);
    process.exit(2);
  }
  return v;
}

function addressOf(deployment: Record<string, unknown>, key: string): Address {
  const v = deployment[key];
  if (typeof v !== 'string' || !isAddress(v)) {
    console.error(`mirror: deployment file has no address for ${key}`);
    process.exit(2);
  }
  return v;
}

const testnet = (rpc: string) =>
  defineChain({
    id: 10143,
    name: 'Monad testnet',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
const mainnet = (rpc: string) =>
  defineChain({
    id: 143,
    name: 'Monad',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

async function main() {
  const once = process.argv.includes('--once');
  const key = need('PRIVATE_KEY', process.env.PRIVATE_KEY);
  const testnetRpc = process.env.TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
  const mainnetRpc = process.env.MAINNET_RPC_URL ?? 'https://rpc.monad.xyz';
  const intervalSeconds = Number(process.env.MIRROR_INTERVAL_SECONDS ?? 300);
  const maxSourceAge = BigInt(process.env.MIRROR_MAX_SOURCE_AGE_SECONDS ?? 7200);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    console.error('mirror: MIRROR_INTERVAL_SECONDS must be a positive integer');
    process.exit(2);
  }

  const file = resolve(process.env.DEPLOYMENT_FILE ?? '../contracts/deployments/10143.json');
  const deployment = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (deployment['chainId'] !== 10143) {
    console.error(`mirror: ${file} is not a chain 10143 deployment`);
    process.exit(2);
  }
  const mock = addressOf(deployment, 'Pyth');

  const account = privateKeyToAccount(key as Hex);
  const testChain = testnet(testnetRpc);
  const test = createPublicClient({ chain: testChain, transport: http(testnetRpc) });
  const wallet = createWalletClient({ account, chain: testChain, transport: http(testnetRpc) });
  const main = createPublicClient({ chain: mainnet(mainnetRpc), transport: http(mainnetRpc) });

  const send = async (request: Parameters<typeof wallet.writeContract>[0]) => {
    const hash = await wallet.writeContract(request);
    const receipt = await test.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
    return hash;
  };

  async function pass(): Promise<boolean> {
    let ok = true;
    for (const name of Object.keys(FEEDS) as FeedName[]) {
      const line: Record<string, unknown> = { at: new Date().toISOString(), feed: name };
      try {
        const [source, sourceBlock, testBlock] = await Promise.all([
          main.readContract({ address: MAINNET_PYTH, abi: sourcePythAbi, functionName: 'getPriceUnsafe', args: [FEEDS[name]] }),
          main.getBlock(),
          test.getBlock(),
        ]);
        const [price, conf, expo, publishTime] = source;
        const plan = planMirror({ price, conf, expo, publishTime }, sourceBlock.timestamp, testBlock.timestamp, maxSourceAge);
        line.sourceAgeSeconds = Number(plan.sourceAgeSeconds);
        if (!plan.ok) {
          line.skipped = plan.reason;
          ok = false;
        } else {
          line.price = `${plan.price.price}e${plan.price.expo}`;
          line.setPrice = await send({
            address: mock,
            abi: mockPythAbi,
            functionName: 'setPrice',
            args: [FEEDS[name], plan.price.price, plan.price.conf, plan.price.expo, plan.price.publishTime],
          });
          const series = addressOf(deployment, DEPLOYMENT_KEYS[name]);
          const [cadence, last] = await Promise.all([
            test.readContract({ address: series, abi: seriesAbi, functionName: 'cadenceSeconds' }),
            test.readContract({ address: series, abi: seriesAbi, functionName: 'lastSampleTimestamp' }),
          ]);
          const now = (await test.getBlock()).timestamp;
          if (last === 0n || now >= last + cadence) {
            line.recordSample = await send({ address: series, abi: seriesAbi, functionName: 'recordSample' });
          } else {
            line.recordSample = 'not_due';
          }
        }
      } catch (e) {
        line.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
        ok = false;
      }
      console.log(JSON.stringify(line));
    }
    return ok;
  }

  console.error(`mirror: ${account.address} -> MockPyth ${mock} on chain 10143`);
  do {
    const ok = await pass();
    if (once) process.exit(ok ? 0 : 1);
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  } while (!once);
}

void main();
