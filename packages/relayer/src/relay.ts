/**
 * One relay pass: get fresh Pyth prices into Pyth on Monad, then have each
 * `CanonicalSeries` record a sample of them.
 *
 * Why two steps. `CanonicalSeries.recordSample()` takes no arguments; it pulls
 * whatever `getPriceNoOlderThan(feedId, maxPriceAgeSeconds)` returns from Pyth.
 * So the Hermes update blob is submitted to Pyth (`updatePriceFeeds`, which
 * charges a small fee in native token), and only then is `recordSample()`
 * called on each series. The series contract is permissionless, pays nothing,
 * and enforces its own cadence: one sample per `cadenceSeconds`.
 *
 * Nothing here trusts the relayer. A wrong or stale blob is rejected by Pyth's
 * own signature check, and a series records only what Pyth serves.
 *
 * Dry-run is the default. `send` is reachable from exactly two places below,
 * and both sit behind `cfg.broadcast`.
 */

import {
  extractPriceUpdates,
  fetchHermesLatest,
  hermesUpdateData,
  type PriceUpdate,
} from '@kanon/spec';
import { canonicalSeriesAbi, pythAbi } from './abi';
import type { RelayerConfig, SeriesTarget } from './config';
import type { ChainPort } from './port';

export type SeriesState = 'recorded' | 'would-record' | 'not-due' | 'failed';

export interface SeriesReport {
  symbol: string;
  address: `0x${string}`;
  state: SeriesState;
  detail?: string;
  /** Unix seconds a `not-due` series next accepts a sample. */
  nextAllowedAt?: number;
  txHash?: `0x${string}`;
  /** The Hermes price this pass carried for the series, when it carried one. */
  hermesPublishTime?: number;
}

export interface UpdateReport {
  status: 'sent' | 'simulated' | 'failed' | 'skipped';
  feeWei?: string;
  txHash?: `0x${string}`;
  detail?: string;
}

export interface RelayReport {
  chainId: number;
  broadcast: boolean;
  update: UpdateReport;
  series: SeriesReport[];
}

export interface RelayDeps {
  port: ChainPort;
  fetchFn: typeof fetch;
}

function message(e: unknown): string {
  if (e instanceof Error) return (e as Error & { shortMessage?: string }).shortMessage ?? e.message;
  return String(e);
}

interface Due {
  target: SeriesTarget;
  report: SeriesReport;
}

export async function relayOnce(cfg: RelayerConfig, deps: RelayDeps): Promise<RelayReport> {
  const { port, fetchFn } = deps;

  const chainId = await port.chainId();
  if (chainId !== cfg.chainId) {
    throw new Error(`RPC is on chain ${chainId}, config expects ${cfg.chainId}. Nothing was sent.`);
  }
  const now = await port.latestBlockTimestamp();

  const reports: SeriesReport[] = [];
  const due: Due[] = [];

  for (const target of cfg.series) {
    const report: SeriesReport = { symbol: target.symbol, address: target.address, state: 'failed' };
    reports.push(report);
    try {
      const contract = { address: target.address, abi: canonicalSeriesAbi } as const;
      const onChainFeed = (await port.read({ ...contract, functionName: 'feedId' })) as string;
      if (onChainFeed.toLowerCase() !== target.feedId) {
        report.detail = `series is pinned to feed ${onChainFeed}, config expects ${target.feedId}`;
        continue;
      }
      const cadence = (await port.read({ ...contract, functionName: 'cadenceSeconds' })) as bigint;
      const last = (await port.read({ ...contract, functionName: 'lastSampleTimestamp' })) as bigint;
      // Mirrors CanonicalSeries.recordSample's own gate, so a pass does not pay to be reverted.
      if (last !== 0n && now < last + cadence) {
        report.state = 'not-due';
        report.nextAllowedAt = Number(last + cadence);
        continue;
      }
      due.push({ target, report });
    } catch (e) {
      report.detail = `could not read series: ${message(e)}`;
    }
  }

  if (due.length === 0) {
    return { chainId, broadcast: cfg.broadcast, update: { status: 'skipped', detail: 'no series is due' }, series: reports };
  }

  const failAll = (detail: string): RelayReport => {
    for (const d of due) {
      d.report.state = 'failed';
      d.report.detail = detail;
    }
    return { chainId, broadcast: cfg.broadcast, update: { status: 'failed', detail }, series: reports };
  };

  // 1. Hermes -> update blob for every due feed, in one request.
  let updateData: `0x${string}`[];
  let prices: PriceUpdate[];
  try {
    const response = await fetchHermesLatest(fetchFn, cfg.hermes, due.map((d) => d.target.feedId));
    updateData = hermesUpdateData(response);
    prices = extractPriceUpdates(response).updates;
  } catch (e) {
    return failAll(`hermes: ${message(e)}`);
  }
  for (const d of [...due]) {
    const p = prices.find((u) => u.feedId === d.target.feedId);
    if (!p) {
      // Never record on the strength of a feed Hermes did not price.
      d.report.state = 'failed';
      d.report.detail = 'hermes returned no price for this feed';
      due.splice(due.indexOf(d), 1);
    } else {
      d.report.hermesPublishTime = p.publishTime;
    }
  }
  if (due.length === 0) {
    return { chainId, broadcast: cfg.broadcast, update: { status: 'skipped', detail: 'hermes priced none of the due feeds' }, series: reports };
  }

  // 2. Fee, then update Pyth.
  let fee: bigint;
  try {
    fee = (await port.read({
      address: cfg.pythAddress,
      abi: pythAbi,
      functionName: 'getUpdateFee',
      args: [updateData],
    })) as bigint;
  } catch (e) {
    return failAll(`getUpdateFee: ${message(e)}`);
  }
  if (fee > cfg.maxUpdateFeeWei) {
    return failAll(`update fee ${fee} wei exceeds MAX_UPDATE_FEE_WEI ${cfg.maxUpdateFeeWei}`);
  }

  const updateCall = {
    address: cfg.pythAddress,
    abi: pythAbi,
    functionName: 'updatePriceFeeds',
    args: [updateData],
    value: fee,
  } as const;

  const update: UpdateReport = { status: 'simulated', feeWei: fee.toString() };
  let updateSimFailed: string | undefined;
  try {
    await port.simulate(updateCall);
  } catch (e) {
    updateSimFailed = message(e);
  }

  if (cfg.broadcast) {
    if (updateSimFailed) return failAll(`updatePriceFeeds would revert: ${updateSimFailed}`);
    try {
      const sent = await port.send(updateCall);
      update.txHash = sent.hash;
      if (!sent.success) return failAll(`updatePriceFeeds reverted on chain (${sent.hash})`);
      update.status = 'sent';
    } catch (e) {
      return failAll(`updatePriceFeeds: ${message(e)}`);
    }
  } else if (updateSimFailed) {
    // Dry run: report it, then keep going so the recordSample simulations still show.
    update.status = 'failed';
    update.detail = `updatePriceFeeds would revert: ${updateSimFailed}`;
  }

  // 3. Each due series records a sample of what Pyth now holds.
  for (const d of due) {
    const call = {
      address: d.target.address,
      abi: canonicalSeriesAbi,
      functionName: 'recordSample',
    } as const;
    try {
      await port.simulate(call);
    } catch (e) {
      d.report.state = 'failed';
      d.report.detail = `recordSample would revert: ${message(e)}`;
      continue;
    }
    if (!cfg.broadcast) {
      d.report.state = 'would-record';
      continue;
    }
    try {
      const sent = await port.send(call);
      d.report.txHash = sent.hash;
      if (sent.success) d.report.state = 'recorded';
      else {
        d.report.state = 'failed';
        d.report.detail = 'recordSample reverted on chain';
      }
    } catch (e) {
      d.report.state = 'failed';
      d.report.detail = `recordSample: ${message(e)}`;
    }
  }

  return { chainId, broadcast: cfg.broadcast, update, series: reports };
}

/** True when nothing failed. A series that is simply not due is not a failure. */
export function reportOk(report: RelayReport): boolean {
  return report.update.status !== 'failed' && report.series.every((s) => s.state !== 'failed');
}
