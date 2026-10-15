import { PYTH_FEEDS, formatDecimal, planMirror, type Decimal, type MirrorPlan } from "@kanon/spec";
import { errorText, recordSampleCall, setPriceCall, type GateCall, type GatePort, type PriceSource } from "./gatePort";
import {
  parseGateEnv,
  parseKeeperSwitch,
  parseSignerEnv,
  type Env,
  type KeeperFeed,
  type SignerEnv,
} from "./serverEnv";

/**
 * The keeper: keeps the on-chain `CanonicalSeries` of every pair a pinned rule
 * uses sampled once per 15-minute bucket, so the gate always has a fresh
 * candle to judge over. It decides nothing about any trade. It only puts the
 * mainnet Pyth price on the testnet mock and asks the series to record it
 * (`packages/spec/src/mirror.ts` says why a mock, and why the testnet clock).
 *
 * Everything here is either pure or talks to a `GatePort`, so the order of
 * calls and every guard are tested with a fake chain (`keeperLogic.test.ts`).
 * The Convex side is `keeper.ts` (the tick) and `keeperData.ts` (the row).
 *
 * Spending is bounded three ways before anything is signed: a minimum balance,
 * a cap on the gas price, and a cap on what the signer spends in a UTC day.
 * Monad bills the gas limit, not the gas used, so the limit is the estimate
 * plus a tenth, and never above `KEEPER_MAX_GAS`.
 */

/** Both deployed series bucket by 15 minutes (`Deploy.s.sol`); the gate judges nothing else. */
export const BUCKET_SECONDS = 900n;

/** How long the signer is held by one tick or one judgment before anyone else may take it. */
export const LEASE_TTL_MS = 120_000;

const DAY_MS = 86_400_000;

/** What a tick wrote and read. The shape of the `keeper` row, without Convex's own fields. */
export interface KeeperRow {
  leaseHolder?: string;
  leaseUntil?: number;
  feeds: string[];
  sampled: Array<{ feed: string; bucket: number }>;
  judgedBucket?: number;
  signer?: string;
  balanceWei?: string;
  balanceAt?: number;
  spentWeiDay: string;
  dayStart: number;
  paused?: string;
  lastError?: string;
  lastErrorAt?: number;
}

/** Why nothing is being sent. Each one stops every send until it clears. */
export type PauseReason = "off" | "not_configured" | "signer_unfunded" | "fee_too_high" | "daily_cap";

export const PAUSE_MESSAGES: Record<PauseReason, string> = {
  off: "The keeper is switched off on this deployment, so the on-chain series are not being sampled.",
  not_configured: "The keeper is not configured on this deployment, so it sends nothing.",
  signer_unfunded: "The keeper's signer holds less than its minimum balance, so it sends nothing until it is topped up.",
  fee_too_high: "Gas on the network is above the keeper's fee cap, so it waits rather than overpay.",
  daily_cap: "The keeper has spent its daily cap, so it sends nothing more until midnight UTC.",
};

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

export type LeaseAnswer = { ok: true; leaseUntil: number } | { ok: false; leaseUntil: number };

/**
 * Whether `holder` may take the signer now. A lease held by someone else and
 * not yet run out is a no; one that ran out is free, so a tick that died
 * holding it blocks the signer for at most `LEASE_TTL_MS`. The holder may renew
 * its own. Run inside a mutation, so two takers are serialised by Convex.
 */
export function leaseDecision(
  row: Pick<KeeperRow, "leaseHolder" | "leaseUntil"> | null,
  holder: string,
  nowMs: number,
): LeaseAnswer {
  const held = row?.leaseHolder !== undefined && row.leaseHolder !== holder && (row.leaseUntil ?? 0) > nowMs;
  if (held) return { ok: false, leaseUntil: row.leaseUntil ?? nowMs };
  return { ok: true, leaseUntil: nowMs + LEASE_TTL_MS };
}

/** Only the holder lets go of a lease. Anyone else's release leaves it as it is. */
export const holdsLease = (row: Pick<KeeperRow, "leaseHolder"> | null, holder: string): boolean =>
  row?.leaseHolder === holder;

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export const utcDayStart = (ms: number): number => ms - (ms % DAY_MS);

/** What the signer has spent since midnight UTC. A row from an earlier day counts as nothing spent. */
export function spentToday(row: Pick<KeeperRow, "spentWeiDay" | "dayStart"> | null, nowMs: number): bigint {
  if (!row || row.dayStart !== utcDayStart(nowMs)) return 0n;
  return BigInt(row.spentWeiDay);
}

/** The day's counter with `wei` more spent, rolled over to today first. */
export function withSpend(
  row: Pick<KeeperRow, "spentWeiDay" | "dayStart"> | null,
  nowMs: number,
  wei: bigint,
): { spentWeiDay: string; dayStart: number } {
  return { spentWeiDay: (spentToday(row, nowMs) + wei).toString(), dayStart: utcDayStart(nowMs) };
}

/** The estimate plus a tenth, rounded up, and capped. Null when even the estimate is over the cap: that is not sent. */
export function gasLimitFor(estimate: bigint, maxGas: bigint): bigint | null {
  if (estimate > maxGas) return null;
  const padded = (estimate * 110n + 99n) / 100n;
  return padded > maxGas ? maxGas : padded;
}

export type SpendLimits = Omit<SignerEnv, "privateKey">;

/** What the gate may spend in a UTC day: the cap less the keeper's reserve, never below nothing. */
export function gateDailySpendWei(limits: Pick<SpendLimits, "dailySpendWei" | "keeperReserveWei">): bigint {
  return limits.dailySpendWei > limits.keeperReserveWei ? limits.dailySpendWei - limits.keeperReserveWei : 0n;
}

/**
 * Whether a send may go ahead. Without `gas` it is the check made before the
 * signer is taken; with it, the check made before each transaction, which
 * also refuses one that could carry the day's spend past the cap at the
 * highest price it bids.
 */
export function sendGuard(
  limits: Pick<SpendLimits, "minBalanceWei" | "maxFeePerGasWei" | "dailySpendWei">,
  now: { balanceWei: bigint; gasPriceWei: bigint; spentTodayWei: bigint },
  gas?: bigint,
): PauseReason | null {
  if (now.balanceWei < limits.minBalanceWei) return "signer_unfunded";
  if (now.gasPriceWei > limits.maxFeePerGasWei) return "fee_too_high";
  if (now.spentTodayWei >= limits.dailySpendWei) return "daily_cap";
  if (gas !== undefined && now.spentTodayWei + gas * limits.maxFeePerGasWei > limits.dailySpendWei) return "daily_cap";
  return null;
}

// ---------------------------------------------------------------------------
// Feeds in use
// ---------------------------------------------------------------------------

export interface PinnedRow {
  ownerUserId: string;
  _creationTime: number;
  status: string;
  pinVerified?: boolean;
  seriesAddress?: string;
}

/**
 * The pairs the keeper keeps fresh: the series of each owner's active rule.
 * An owner's active rule is their newest pinned or cooling-off one, as the app
 * shows it (`pickStrategies` in packages/ui), so a rule a newer pin replaced
 * stops counting. Only a pin the backend read from the chain counts, and only
 * on a series the deployment names (`feedOfSeries`).
 */
export function feedsInUse(rows: readonly PinnedRow[], feedOfSeries: (series: string) => string | undefined): string[] {
  const active = new Map<string, PinnedRow>();
  for (const row of rows) {
    if (row.status !== "pinned" && row.status !== "cooling_off") continue;
    const current = active.get(row.ownerUserId);
    if (!current || row._creationTime > current._creationTime) active.set(row.ownerUserId, row);
  }
  const feeds = new Set<string>();
  for (const row of active.values()) {
    if (row.pinVerified !== true || !row.seriesAddress) continue;
    const feed = feedOfSeries(row.seriesAddress.toLowerCase());
    if (feed) feeds.add(feed);
  }
  return [...feeds].sort();
}

/** Looks a series address up in the deployment's `SERIES_*_ADDRESS` set. */
export function feedOfSeriesIn(series: Partial<Record<KeeperFeed, string>>): (address: string) => string | undefined {
  const byAddress = new Map(Object.entries(series).map(([feed, address]) => [String(address).toLowerCase(), feed]));
  return (address) => byAddress.get(address.toLowerCase());
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "nonce too low" (another transaction took the nonce) or "already known" (the node holds this one). */
export const isNonceError = (e: unknown): boolean =>
  /nonce too low|lower than the current nonce|already known/i.test(errorText(e));

/**
 * One line fit to log and to store where a client can read it. RPC URLs can
 * carry a key, so any URL is dropped, and anything in `secrets` is blanked.
 */
export function sentence(e: unknown, secrets: readonly string[] = []): string {
  const x = e as { shortMessage?: unknown; message?: unknown } | null;
  const raw = typeof x?.shortMessage === "string" ? x.shortMessage : typeof x?.message === "string" ? x.message : String(e);
  let line = raw.split("\n")[0] ?? "";
  for (const secret of secrets) {
    if (!secret) continue;
    line = line.split(secret).join("[redacted]").split(secret.toLowerCase()).join("[redacted]");
  }
  return line.replace(/\b(?:https?|wss?):\/\/\S+/gi, "[rpc]").slice(0, 240);
}

/** Wei as MON, cut (not rounded) to `places`. */
export function formatMon(wei: bigint, places = 4): string {
  const scale = 10n ** BigInt(18 - places);
  return formatDecimal({ atoms: (wei / scale).toString(), decimals: places }, { group: false });
}

export const topUpLine = (signer: string, balanceWei: bigint, spentWei: bigint): string =>
  `keeper: signer ${signer} has ${formatMon(balanceWei)} MON, spent ${formatMon(spentWei)} in 24h; top up`;

const MIRROR_REFUSALS: Record<Extract<MirrorPlan, { ok: false }>["reason"], (age: bigint) => string> = {
  source_stale: (age) => `the mainnet price is ${age}s old, past the keeper's limit, so it was not mirrored`,
  source_not_positive: () => "the mainnet price is not positive, so it was not mirrored",
  source_from_future: () => "the mainnet price is stamped after the mainnet clock, so it was not mirrored",
};

/** The mainnet price was not one the keeper mirrors (`planMirror`). Nothing was sent for it. */
export class SourceRefused extends Error {
  constructor(readonly reason: Extract<MirrorPlan, { ok: false }>["reason"], ageSeconds: bigint) {
    super(MIRROR_REFUSALS[reason](ageSeconds));
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface KeeperTickInput {
  port: GatePort;
  source: PriceSource;
  /** From the keeper row. The tick never reads `strategies`. */
  feeds: readonly string[];
  series: Partial<Record<string, `0x${string}`>>;
  mockPyth: `0x${string}`;
  limits: SpendLimits & { maxGas: bigint; maxSourceAgeSeconds: bigint };
  spentTodayWei: bigint;
  lease: { acquire(): Promise<boolean>; release(spentWei: bigint): Promise<void> };
  log?: (level: "info" | "warn" | "error", line: string) => void;
  /** Blanked from every error sentence. */
  secrets?: readonly string[];
}

export interface KeeperTickReport {
  /** The bucket the tick looked at: the testnet block time over 900. Null when even that could not be read. */
  bucket: number | null;
  /** The testnet block time the bucket was read from, unix seconds. */
  blockTime?: number;
  /** Feeds the chain shows recorded, at the bucket each was recorded in. */
  sampled: Array<{ feed: string; bucket: number }>;
  sent: Array<{ feed: string; call: string; hash: `0x${string}`; costWei: bigint }>;
  spentWei: bigint;
  /** The signer's balance as read before sending. */
  balanceWei?: bigint;
  paused: PauseReason | null;
  /** The signer was held by someone else; tried again next minute. */
  busy: boolean;
  errors: string[];
  /** Feeds whose mainnet price was refused (`SourceRefused`): their line is in `errors` too. */
  sourceRefused?: string[];
}

/** A guard tripped: nothing more is sent this tick. */
class Pause extends Error {
  constructor(readonly reason: PauseReason) {
    super(PAUSE_MESSAGES[reason]);
  }
}

/**
 * One pass:
 *
 *   1. Read the testnet block time, and `getCandle` of its bucket for each feed
 *      in use. A recorded candle is left alone.
 *   2. For any feed without one, check the balance, the gas price and the
 *      day's spend before taking the signer. Any guard tripped sends nothing.
 *   3. Under the lease, per feed: check the series' cadence, read mainnet Pyth,
 *      `setPrice` on the mock stamped with the testnet block time, then
 *      `recordSample`, then read the candle again and require it recorded.
 *
 * A nonce error is retried once; the port fetches the nonce afresh each send.
 */
export async function runKeeperTick(input: KeeperTickInput): Promise<KeeperTickReport> {
  const { port, source, limits } = input;
  const log = input.log ?? (() => undefined);
  const secrets = input.secrets ?? [];
  const report: KeeperTickReport = { bucket: null, sampled: [], sent: [], spentWei: 0n, paused: null, busy: false, errors: [] };

  const blockTime = await port.blockTime();
  const bucket = blockTime / BUCKET_SECONDS;
  report.bucket = Number(bucket);
  report.blockTime = Number(blockTime);

  const due: Array<{ feed: string; series: `0x${string}` }> = [];
  for (const feed of input.feeds) {
    const series = input.series[feed];
    if (!series) {
      report.errors.push(`${feed}: no series is configured for it on this deployment.`);
      continue;
    }
    const candle = await port.getCandle(series, bucket);
    if (candle.recorded) report.sampled.push({ feed, bucket: Number(bucket) });
    else due.push({ feed, series });
  }
  if (due.length === 0) return report;

  const signer = port.signer ?? "(none)";
  const [balance, gasPrice] = await Promise.all([port.balance(), port.gasPrice()]);
  report.balanceWei = balance;
  const before = sendGuard(limits, { balanceWei: balance, gasPriceWei: gasPrice, spentTodayWei: input.spentTodayWei });
  if (balance < limits.warnBalanceWei || before === "signer_unfunded" || before === "daily_cap") {
    log("warn", topUpLine(signer, balance, input.spentTodayWei));
  }
  if (before) {
    report.paused = before;
    log("warn", `keeper: ${PAUSE_MESSAGES[before]}`);
    return report;
  }

  if (!(await input.lease.acquire())) {
    report.busy = true;
    return report;
  }

  let spent = 0n;

  /** Estimate, guard, send, wait. Every wei the chain can bill for it is counted, a lost receipt included. */
  async function transact(feed: string, label: string, call: GateCall): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const estimate = await port.estimateGas(call);
        const gas = gasLimitFor(estimate, limits.maxGas);
        if (gas === null) throw new Error(`${label} needs ${estimate} gas, above the keeper's limit of ${limits.maxGas}`);
        const stop = sendGuard(
          limits,
          { balanceWei: balance - spent, gasPriceWei: gasPrice, spentTodayWei: input.spentTodayWei + spent },
          gas,
        );
        if (stop) throw new Pause(stop);
        const hash = await port.send(call, { gas, maxFeePerGas: limits.maxFeePerGasWei });
        let costWei: bigint;
        let status: "success" | "reverted";
        try {
          const receipt = await port.waitForReceipt(hash);
          // Monad bills the limit: gasUsed equals gas on its receipts.
          costWei = gas * receipt.effectiveGasPrice;
          status = receipt.status;
        } catch (e) {
          // Unconfirmed is not unspent. The most it can cost is counted, so the cap is never under-read.
          spent += gas * limits.maxFeePerGasWei;
          throw new Error(`${label} ${hash} was sent and not confirmed: ${sentence(e, secrets)}`);
        }
        spent += costWei;
        report.sent.push({ feed, call: label, hash, costWei });
        log("info", `keeper: ${feed} ${label} ${hash} cost ${formatMon(costWei, 6)} MON`);
        if (status !== "success") throw new Error(`${label} ${hash} reverted`);
        return;
      } catch (e) {
        if (attempt === 1 && !(e instanceof Pause) && isNonceError(e)) {
          log("warn", `keeper: ${feed} ${label} met a nonce error; fetching the nonce again and trying once more`);
          continue;
        }
        throw e;
      }
    }
  }

  async function sample(feed: string, series: `0x${string}`): Promise<number | null> {
    const feedId = PYTH_FEEDS[feed];
    if (!feedId) throw new Error(`${feed} has no Pyth feed id`);
    // A series address set against the wrong pair would record that pair's mock price under this one.
    const pinned = await port.seriesFeedId(series);
    if (pinned.toLowerCase() !== feedId.toLowerCase()) throw new Error(`the series configured for ${feed} samples another feed`);

    // The cadence first: a price the series cannot record yet is gas for nothing.
    const [last, cadence, now] = await Promise.all([port.lastSampleTimestamp(series), port.cadenceSeconds(series), port.blockTime()]);
    if (last !== 0n && now < last + cadence) return null;

    const { price, sourceNowSeconds } = await source.read(feedId);
    const plan = planMirror(price, sourceNowSeconds, now, limits.maxSourceAgeSeconds);
    if (!plan.ok) throw new SourceRefused(plan.reason, plan.sourceAgeSeconds);
    const target = plan.price.publishTime / BUCKET_SECONDS;

    await transact(feed, "setPrice", setPriceCall(input.mockPyth, feedId, plan.price));
    await transact(feed, "recordSample", recordSampleCall(series));
    const after = await port.getCandle(series, target);
    if (!after.recorded) throw new Error(`recordSample was confirmed and bucket ${target} is still not recorded`);
    return Number(target);
  }

  try {
    for (const { feed, series } of due) {
      try {
        const recorded = await sample(feed, series);
        if (recorded !== null) report.sampled.push({ feed, bucket: recorded });
      } catch (e) {
        if (e instanceof Pause) {
          report.paused = e.reason;
          log("warn", `keeper: ${e.message}`);
          break;
        }
        const line = `${feed}: ${sentence(e, secrets)}`;
        report.errors.push(line);
        if (e instanceof SourceRefused) report.sourceRefused = [...(report.sourceRefused ?? []), feed];
        log("error", `keeper: ${line}`);
      }
    }
  } finally {
    report.spentWei = spent;
    await input.lease.release(spent);
  }
  return report;
}

// ---------------------------------------------------------------------------
// What a tick writes back
// ---------------------------------------------------------------------------

/** A type, not an interface: it is a Convex function's arguments (`keeperData:noteTick`). */
export type TickNote = {
  sampled: Array<{ feed: string; bucket: number }>;
  paused: string | null;
  error: string | null;
  balanceWei?: string;
  signer?: string;
};

/** A report that says only "the tick itself failed". */
export const failedTick = (error: string): KeeperTickReport => ({
  bucket: null,
  sampled: [],
  sent: [],
  spentWei: 0n,
  paused: null,
  busy: false,
  errors: [error],
});

/**
 * What the tick writes to the keeper row, or null when nothing changed. Most
 * minutes nothing has, and the row is not written: the free plan's I/O is
 * spent once per bucket, not once per minute.
 */
export function tickNote(row: KeeperRow | null, report: KeeperTickReport, signer: string | undefined): TickNote | null {
  const feeds = row?.feeds ?? [];
  const byFeed = new Map((row?.sampled ?? []).filter((s) => feeds.includes(s.feed)).map((s) => [s.feed, s.bucket]));
  for (const s of report.sampled) byFeed.set(s.feed, Math.max(s.bucket, byFeed.get(s.feed) ?? 0));
  const sampled = [...byFeed.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([feed, bucket]) => ({ feed, bucket }));

  const error = report.errors.length > 0 ? report.errors.join(" ") : null;
  const balanceWei = report.balanceWei === undefined ? undefined : (report.balanceWei - report.spentWei).toString();
  const changed =
    report.sent.length > 0 ||
    JSON.stringify(sampled) !== JSON.stringify(row?.sampled ?? []) ||
    (report.paused ?? null) !== (row?.paused ?? null) ||
    (error !== null && error !== row?.lastError) ||
    (balanceWei !== undefined && balanceWei !== row?.balanceWei) ||
    (signer !== undefined && signer !== row?.signer);
  if (!changed) return null;
  return {
    sampled,
    paused: report.paused,
    error,
    ...(balanceWei !== undefined ? { balanceWei } : {}),
    ...(signer !== undefined ? { signer } : {}),
  };
}

// ---------------------------------------------------------------------------
// What anyone may read
// ---------------------------------------------------------------------------

const mon = (wei: bigint): Decimal => ({ atoms: wei.toString(), decimals: 18 });

export interface KeeperView {
  enabled: boolean;
  /** The signer's address. Public on-chain; the key never leaves the deployment's env. */
  signer: string | null;
  balance: Decimal | null;
  balanceAt: number | null;
  spentToday: Decimal;
  dailyCap: Decimal | null;
  feeds: string[];
  /** The last bucket (unix seconds over 900) each feed was seen recorded in. */
  sampled: Array<{ feed: string; bucket: number }>;
  paused: PauseReason | null;
  pausedMessage: string | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

/** The keeper's health, from its row and the deployment's switch. Nothing secret: no key, no URL. */
export function keeperView(row: KeeperRow | null, env: Env, nowMs: number): KeeperView {
  const on = parseKeeperSwitch(env);
  const signerEnv = parseSignerEnv(env);
  const gateEnv = parseGateEnv(env);
  const paused: PauseReason | null = !on.ok
    ? "not_configured"
    : !on.value
      ? "off"
      : !signerEnv.ok || !gateEnv.ok
        ? "not_configured"
        : ((row?.paused as PauseReason | undefined) ?? null);
  return {
    enabled: on.ok && on.value,
    signer: row?.signer ?? null,
    balance: row?.balanceWei !== undefined ? mon(BigInt(row.balanceWei)) : null,
    balanceAt: row?.balanceAt ?? null,
    spentToday: mon(spentToday(row, nowMs)),
    dailyCap: signerEnv.ok ? mon(signerEnv.value.dailySpendWei) : null,
    feeds: row?.feeds ?? [],
    sampled: row?.sampled ?? [],
    paused,
    pausedMessage: paused ? PAUSE_MESSAGES[paused] : null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
  };
}

/** For `npx convex run keeperData:status`: the view, plus the lease, the limits in force and what is misconfigured, by name. */
export function keeperStatus(row: KeeperRow | null, env: Env, nowMs: number) {
  const view = keeperView(row, env, nowMs);
  const signerEnv = parseSignerEnv(env);
  const gateEnv = parseGateEnv(env);
  const on = parseKeeperSwitch(env);
  const problems = [
    ...(on.ok ? [] : on.invalid),
    ...(signerEnv.ok ? [] : signerEnv.invalid),
    ...(gateEnv.ok ? [] : gateEnv.invalid),
  ];
  return {
    ...view,
    balanceMon: view.balance ? formatMon(BigInt(view.balance.atoms)) : null,
    spentTodayMon: formatMon(BigInt(view.spentToday.atoms)),
    dailyCapMon: view.dailyCap ? formatMon(BigInt(view.dailyCap.atoms)) : null,
    /** The last bucket (unix seconds over 900) autopilot judged clean on the gate. */
    judgedBucket: row?.judgedBucket ?? null,
    lease:
      row?.leaseHolder !== undefined && (row.leaseUntil ?? 0) > nowMs
        ? { holder: row.leaseHolder, until: row.leaseUntil ?? null }
        : null,
    limits: signerEnv.ok
      ? {
          minBalanceMon: formatMon(signerEnv.value.minBalanceWei),
          warnBalanceMon: formatMon(signerEnv.value.warnBalanceWei),
          maxFeeGwei: formatDecimal({ atoms: signerEnv.value.maxFeePerGasWei.toString(), decimals: 9 }, { group: false }),
          ...(gateEnv.ok
            ? {
                keeperMaxGas: gateEnv.value.keeperMaxGas.toString(),
                gateMaxGas: gateEnv.value.gateMaxGas.toString(),
                maxSourceAgeSeconds: gateEnv.value.maxSourceAgeSeconds.toString(),
              }
            : {}),
        }
      : null,
    series: gateEnv.ok ? gateEnv.value.series : null,
    problems: [...new Set(problems)],
  };
}
