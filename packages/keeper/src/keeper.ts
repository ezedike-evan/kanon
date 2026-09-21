/**
 * One keeper pass over a MarginAccount.
 *
 *   1. Ask the AccountSource for candidate accounts and merge them into the
 *      tracked set.
 *   2. For every tracked account, ask the CONTRACT how healthy it is
 *      (`healthFactor`) and where the bands are (`adlHealthThreshold`,
 *      `LIQUIDATION_THRESHOLD`). The keeper never recomputes health off-chain;
 *      it only compares the contract's own number with the contract's own
 *      thresholds to choose which permissionless call to try.
 *        health >= adl threshold        healthy, skipped
 *        1.0 <= health < adl threshold  deleverage(account)
 *        health < 1.0                   liquidate(account, largest open position)
 *   3. Every action is simulated first. If the contract itself refuses
 *      (`NotLiquidatable`, `NotDeleverageable`, ...) someone else got there
 *      first, which is reported as `raced` and is not an error.
 *
 * Idempotent by construction: nothing is remembered between passes except the
 * set of accounts to look at, so a crashed, restarted or duplicated keeper
 * converges on the same state. A failed or reverted transaction is reported on
 * the account and the loop moves on.
 *
 * Dry run is the default. `port.send` is reachable from exactly one place
 * (`execute`), behind `cfg.broadcast`.
 */

import { canonicalSeriesAbi, marginAccountAbi } from './abi';
import type { KeeperConfig } from './config';
import { silentLogger, type Logger } from './log';
import type { ChainPort, ContractCall } from './port';
import { PartialDiscoveryError, type AccountSource } from './source';

export type ActionKind = 'deleverage' | 'liquidate' | 'record_sample';

export type ActionOutcome =
  | 'sent'
  | 'would_send'
  | 'raced'
  | 'reverted'
  | 'failed'
  | 'over_gas_cap'
  | 'over_fee_cap'
  | 'budget_exhausted';

export interface ActionReport {
  action: ActionKind;
  outcome: ActionOutcome;
  target?: `0x${string}`;
  positionId?: string;
  gasEstimate?: string;
  txHash?: `0x${string}`;
  detail?: string;
}

export type AccountOutcome =
  | 'flat' // nothing open (dropped from the tracked set)
  | 'healthy' // contract says healthy, skipped
  | 'recovered' // healthy after this pass acted on it
  | 'closed' // no open positions left after this pass acted on it
  | 'action_limit' // MAX_ACTIONS_PER_ACCOUNT reached while still unhealthy
  | 'unpriced' // no sample in the current bucket and none could be recorded
  | 'failed' // a read failed
  | ActionOutcome;

export interface AccountReport {
  account: `0x${string}`;
  outcome: AccountOutcome;
  /** The contract's health factor (1e18 = 1.0) before the pass acted, as a decimal string. */
  health?: string;
  actions: ActionReport[];
  detail?: string;
}

export interface PassReport {
  chainId: number;
  broadcast: boolean;
  discovery: { fromBlock?: string; toBlock?: string; found: number; error?: string };
  tracked: number;
  txsUsed: number;
  accounts: AccountReport[];
}

export class ChainMismatchError extends Error {
  constructor(actual: number, expected: number) {
    super(`RPC is on chain ${actual}, config expects ${expected}. Nothing was sent.`);
    this.name = 'ChainMismatchError';
  }
}

export interface KeeperDeps {
  port: ChainPort;
  source: AccountSource;
  log?: Logger;
}

// Reverts that mean "the contract says the situation is not what you thought":
// somebody else acted first, or the account changed under us.
const RACE_ERRORS = ['NotLiquidatable', 'NotDeleverageable', 'NothingToDeleverage', 'PositionNotOpen'] as const;
const KNOWN_ERRORS = [...RACE_ERRORS, 'NoRecentPrice', 'PositionNotFound'] as const;

/** Gas headroom over the estimate. Monad charges the limit, so keep it tight. */
const GAS_HEADROOM_NUM = 120n;
const GAS_HEADROOM_DEN = 100n;

interface ErrorLike {
  message?: string;
  shortMessage?: string;
  details?: string;
  metaMessages?: string[];
  data?: { errorName?: string };
  cause?: unknown;
  name?: string;
}

function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (typeof cur === 'string') {
      parts.push(cur);
      break;
    }
    const x = cur as ErrorLike;
    if (x.data?.errorName) parts.push(x.data.errorName);
    if (x.shortMessage) parts.push(x.shortMessage);
    if (x.message) parts.push(x.message);
    if (x.details) parts.push(x.details);
    if (x.metaMessages) parts.push(...x.metaMessages);
    cur = x.cause;
  }
  return parts.join('\n');
}

/** The custom-error name a revert carries, when it is one the keeper knows. */
export function revertName(e: unknown): (typeof KNOWN_ERRORS)[number] | undefined {
  const text = errorText(e);
  return KNOWN_ERRORS.find((n) => new RegExp(`\\b${n}\\b`).test(text));
}

function brief(e: unknown): string {
  const x = e as ErrorLike;
  return (x?.shortMessage ?? x?.message ?? String(e)).split('\n')[0]!.slice(0, 240);
}

interface OpenPosition {
  id: bigint;
  series: `0x${string}`;
  size: bigint;
}

type Health = { kind: 'ok'; value: bigint } | { kind: 'unpriced' } | { kind: 'error'; detail: string };

export interface Keeper {
  runPass(): Promise<PassReport>;
  /** Accounts currently being watched. */
  tracked(): `0x${string}`[];
}

export function createKeeper(cfg: KeeperConfig, deps: KeeperDeps): Keeper {
  const { port, source } = deps;
  const log = deps.log ?? silentLogger;
  const trackedSet = new Map<string, `0x${string}`>();

  const margin = (functionName: string, args: readonly unknown[] = []): ContractCall => ({
    address: cfg.marginAddress,
    abi: marginAccountAbi,
    functionName,
    args,
  });

  const track = (a: `0x${string}`) => {
    if (!trackedSet.has(a.toLowerCase())) trackedSet.set(a.toLowerCase(), a);
  };

  async function runPass(): Promise<PassReport> {
    const chainId = await port.chainId();
    if (chainId !== cfg.chainId) throw new ChainMismatchError(chainId, cfg.chainId);

    let txsUsed = 0;
    const sampleTried = new Map<string, ActionReport>();

    // ---- discovery -------------------------------------------------------
    const discovery: PassReport['discovery'] = { found: 0 };
    for (const a of cfg.extraAccounts) track(a);
    try {
      const d = await source.poll(port);
      for (const a of d.accounts) track(a);
      discovery.found = d.accounts.length;
      if (d.fromBlock !== undefined) discovery.fromBlock = d.fromBlock.toString();
      if (d.toBlock !== undefined) discovery.toBlock = d.toBlock.toString();
    } catch (e) {
      // Keep going with what we already track: a discovery outage must not stop
      // the keeper policing accounts it already knows about.
      if (e instanceof PartialDiscoveryError) {
        for (const a of e.accounts) track(a);
        discovery.found = e.accounts.length;
      }
      discovery.error = brief(e);
      log({ level: 'warn', event: 'discovery_failed', error: discovery.error });
    }
    log({ level: 'info', event: 'pass_start', chainId, broadcast: cfg.broadcast, tracked: trackedSet.size, discovery });

    // ---- thresholds, from the contract ----------------------------------
    let adlThreshold: bigint;
    let liqThreshold: bigint;
    try {
      [adlThreshold, liqThreshold] = (await Promise.all([
        port.read(margin('adlHealthThreshold')),
        port.read(margin('LIQUIDATION_THRESHOLD')),
      ])) as [bigint, bigint];
    } catch (e) {
      log({ level: 'error', event: 'thresholds_unreadable', error: brief(e) });
      throw new Error(`cannot read the risk thresholds from ${cfg.marginAddress}: ${brief(e)}`);
    }

    // ---- helpers bound to this pass -------------------------------------
    async function execute(action: ActionKind, call: ContractCall, extra: Partial<ActionReport> = {}): Promise<ActionReport> {
      const report: ActionReport = { action, outcome: 'failed', target: call.address, ...extra };
      const done = (r: ActionReport): ActionReport => {
        log({ level: r.outcome === 'sent' || r.outcome === 'would_send' ? 'info' : 'warn', event: 'action', ...r });
        return r;
      };

      if (txsUsed >= cfg.maxTxsPerPass) return done({ ...report, outcome: 'budget_exhausted' });

      let gas: bigint;
      try {
        ({ gas } = await port.simulate(call));
      } catch (e) {
        const name = revertName(e);
        if (name && (RACE_ERRORS as readonly string[]).includes(name)) {
          return done({ ...report, outcome: 'raced', detail: name });
        }
        return done({ ...report, outcome: 'failed', detail: brief(e) });
      }
      report.gasEstimate = gas.toString();

      if (gas > cfg.maxGasPerTx) {
        return done({ ...report, outcome: 'over_gas_cap', detail: `estimate ${gas} > cap ${cfg.maxGasPerTx}` });
      }
      let price: bigint;
      try {
        price = await port.gasPrice();
      } catch (e) {
        return done({ ...report, outcome: 'failed', detail: `gas price unavailable: ${brief(e)}` });
      }
      if (price > cfg.maxGasPriceWei) {
        return done({ ...report, outcome: 'over_fee_cap', detail: `gas price ${price} > cap ${cfg.maxGasPriceWei}` });
      }

      txsUsed++;
      if (!cfg.broadcast) return done({ ...report, outcome: 'would_send' });

      const padded = (gas * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
      const limit = padded > cfg.maxGasPerTx ? cfg.maxGasPerTx : padded;
      try {
        const { hash, success } = await port.send(call, { gas: limit, maxFeePerGas: cfg.maxGasPriceWei });
        return done({ ...report, outcome: success ? 'sent' : 'reverted', txHash: hash });
      } catch (e) {
        return done({ ...report, outcome: 'failed', detail: brief(e) });
      }
    }

    async function readHealth(account: `0x${string}`): Promise<Health> {
      try {
        return { kind: 'ok', value: (await port.read(margin('healthFactor', [account]))) as bigint };
      } catch (e) {
        if (revertName(e) === 'NoRecentPrice') return { kind: 'unpriced' };
        return { kind: 'error', detail: brief(e) };
      }
    }

    /** Open positions, newest first. Stops as soon as `expected` open ones are found. */
    async function openPositions(account: `0x${string}`, expected: number): Promise<OpenPosition[]> {
      const total = Number((await port.read(margin('positionCount', [account]))) as bigint);
      const out: OpenPosition[] = [];
      for (let i = total - 1; i >= 0 && out.length < expected; i--) {
        const [series, , size, , open] = (await port.read(margin('positionOf', [account, BigInt(i)]))) as [
          `0x${string}`,
          boolean,
          bigint,
          bigint,
          boolean,
        ];
        if (open) out.push({ id: BigInt(i), series, size });
      }
      return out;
    }

    /** Records a sample on each series the account trades, so `healthFactor` can be read. */
    async function recordSamples(account: `0x${string}`, expected: number, actions: ActionReport[]): Promise<boolean> {
      const positions = await openPositions(account, expected);
      let any = false;
      for (const series of new Set(positions.map((p) => p.series))) {
        let r = sampleTried.get(series.toLowerCase());
        if (!r) {
          r = await execute('record_sample', { address: series, abi: canonicalSeriesAbi, functionName: 'recordSample' });
          sampleTried.set(series.toLowerCase(), r);
          actions.push(r);
        }
        if (r.outcome === 'sent') any = true;
      }
      return any;
    }

    // ---- per account ------------------------------------------------------
    async function handle(account: `0x${string}`): Promise<AccountReport> {
      const rep: AccountReport = { account, outcome: 'healthy', actions: [] };
      for (let step = 0; step <= cfg.maxActionsPerAccount; step++) {
        const open = Number((await port.read(margin('openPositionCount', [account]))) as bigint);
        if (open === 0) {
          rep.outcome = step === 0 ? 'flat' : 'closed';
          return rep;
        }

        let health = await readHealth(account);
        if (health.kind === 'unpriced' && cfg.recordSamples) {
          const recorded = await recordSamples(account, open, rep.actions);
          if (recorded) health = await readHealth(account);
        }
        if (health.kind === 'unpriced') {
          rep.outcome = 'unpriced';
          return rep;
        }
        if (health.kind === 'error') {
          rep.outcome = 'failed';
          rep.detail = health.detail;
          return rep;
        }
        const h = health.value;
        if (step === 0) rep.health = h.toString();

        if (h >= adlThreshold) {
          rep.outcome = step === 0 ? 'healthy' : 'recovered';
          return rep;
        }
        if (step === cfg.maxActionsPerAccount) {
          rep.outcome = 'action_limit';
          return rep;
        }

        let result: ActionReport;
        if (h < liqThreshold) {
          const positions = await openPositions(account, open);
          // Largest first, lowest id on a tie, mirroring the contract's own ADL choice.
          positions.sort((a, b) => (a.size === b.size ? Number(a.id - b.id) : a.size > b.size ? -1 : 1));
          const target = positions[0];
          if (!target) {
            rep.outcome = 'failed';
            rep.detail = 'contract reports open positions but none could be read';
            return rep;
          }
          result = await execute('liquidate', margin('liquidate', [account, target.id]), {
            positionId: target.id.toString(),
          });
        } else {
          result = await execute('deleverage', margin('deleverage', [account]));
        }
        rep.actions.push(result);
        if (result.outcome !== 'sent') {
          rep.outcome = result.outcome;
          if (result.detail) rep.detail = result.detail;
          return rep;
        }
      }
      rep.outcome = 'action_limit';
      return rep;
    }

    const accounts: AccountReport[] = [];
    for (const account of [...trackedSet.values()]) {
      let rep: AccountReport;
      try {
        rep = await handle(account);
      } catch (e) {
        rep = { account, outcome: 'failed', actions: [], detail: brief(e) };
      }
      if (rep.outcome === 'flat') trackedSet.delete(account.toLowerCase());
      accounts.push(rep);
      log({
        level: rep.outcome === 'failed' ? 'warn' : 'info',
        event: 'account',
        account,
        outcome: rep.outcome,
        health: rep.health,
        detail: rep.detail,
      });
    }

    const report: PassReport = { chainId, broadcast: cfg.broadcast, discovery, tracked: trackedSet.size, txsUsed, accounts };
    log({ level: 'info', event: 'pass_end', tracked: trackedSet.size, txsUsed, accounts: accounts.length });
    return report;
  }

  return { runPass, tracked: () => [...trackedSet.values()] };
}

/** True when nothing in the pass needs an operator: no failed read, no failed or reverted tx. */
export function passOk(report: PassReport): boolean {
  if (report.discovery.error) return false;
  return report.accounts.every(
    (a) => a.outcome !== 'failed' && a.actions.every((x) => x.outcome !== 'failed' && x.outcome !== 'reverted'),
  );
}
