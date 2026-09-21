/**
 * Non-custodial copy trading: the pure arithmetic.
 *
 * `CopyVault.sol` scales a leader's attested trade by the follower's
 * `allocationBps` and, on a profitable close, keeps `feeShareBps` of the
 * profit for the leader. These functions are that arithmetic, in bigint atoms,
 * with the rounding rule written down beside each one, so the UI can show a
 * follower the exact figures before they follow and a test can prove that no
 * atom is created or lost between them.
 *
 * Nothing here is a float. Nothing here calls a model.
 */

const BPS = 10_000n;

export const COPY_MAX_BPS = 10_000;

export interface CopyTerms {
  /** How much of each leader trade's size the follower mirrors, in bps. 1..10_000. */
  allocationBps: number;
  /** The leader's cut of a profitable close, in bps. 0..10_000. Never charged on a loss. */
  feeShareBps: number;
}

export interface CopyIssue {
  field: 'allocationBps' | 'feeShareBps';
  message: string;
}

/** Mirrors the constructor's own requires. */
export function validateCopyTerms(terms: CopyTerms): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const { allocationBps, feeShareBps } = terms;
  if (!Number.isInteger(allocationBps) || allocationBps < 1 || allocationBps > COPY_MAX_BPS) {
    issues.push({
      field: 'allocationBps',
      message: `Allocation must be a whole number of basis points from 1 to ${COPY_MAX_BPS}.`,
    });
  }
  if (!Number.isInteger(feeShareBps) || feeShareBps < 0 || feeShareBps > COPY_MAX_BPS) {
    issues.push({
      field: 'feeShareBps',
      message: `Profit share must be a whole number of basis points from 0 to ${COPY_MAX_BPS}.`,
    });
  }
  return issues;
}

/**
 * The follower's size for one leader trade: `floor(leaderSize * allocationBps / 10_000)`.
 * Rounds DOWN, so a follower is never allocated more than their share. The
 * fraction that rounding drops is `mirrorRemainder`, never silently added
 * elsewhere.
 */
export function mirrorSize(leaderSize: bigint, allocationBps: number): bigint {
  return (leaderSize * BigInt(allocationBps)) / BPS;
}

/** The numerator the floor dropped, out of 10_000: `leaderSize*bps - size*10_000`. */
export function mirrorRemainder(leaderSize: bigint, allocationBps: number): bigint {
  return leaderSize * BigInt(allocationBps) - mirrorSize(leaderSize, allocationBps) * BPS;
}

/**
 * The allocation that makes a follower's position proportional to the leader's
 * account: `floor(followerCapital * 10_000 / leaderCapital)`, clamped to
 * `[1, 10_000]`. Rounds down, so proportional sizing never over-allocates; a
 * follower with more capital than the leader is capped at 100%, not levered.
 */
export function proportionalAllocationBps(followerCapital: bigint, leaderCapital: bigint): number {
  if (leaderCapital <= 0n || followerCapital <= 0n) return 1;
  const raw = (followerCapital * BPS) / leaderCapital;
  if (raw < 1n) return 1;
  if (raw > BPS) return COPY_MAX_BPS;
  return Number(raw);
}

/**
 * P&L of a mirrored position, in collateral atoms:
 * `followerSize * (exit - entry) / entry`, sign flipped for a short.
 *
 * Integer division truncates toward zero, exactly as the contract's signed
 * division does, so a loss and a gain of equal magnitude round the same way.
 */
export function mirrorPnl(input: {
  followerSize: bigint;
  entryPrice: bigint;
  exitPrice: bigint;
  isLong: boolean;
}): bigint {
  const { followerSize, entryPrice, exitPrice, isLong } = input;
  if (entryPrice <= 0n) throw new Error('entry price must be positive');
  const pnl = (followerSize * (exitPrice - entryPrice)) / entryPrice;
  return isLong ? pnl : -pnl;
}

export interface ProfitSplit {
  /** What the leader keeps. Zero unless the close was profitable. */
  fee: bigint;
  /** What lands in the follower's ledger: the profit less the fee, or the loss in full. */
  followerNet: bigint;
}

/**
 * Splits one close. On a profit the fee is `floor(pnl * feeShareBps / 10_000)`
 * (rounded down, in the follower's favour) and the follower keeps the rest, so
 * `fee + followerNet === pnl` exactly. On a loss or a flat close the fee is
 * zero and the follower bears the whole loss. The leader never pays for a loss
 * and is never paid for one.
 */
export function splitProfit(pnl: bigint, feeShareBps: number): ProfitSplit {
  if (pnl <= 0n) return { fee: 0n, followerNet: pnl };
  const fee = (pnl * BigInt(feeShareBps)) / BPS;
  return { fee, followerNet: pnl - fee };
}

/**
 * Splits `total` across `weights` so the parts sum to `total` exactly: each
 * gets the floor of its exact share and the leftover atoms go one each to the
 * largest remainders, ties to the lower index. No dust is created or lost.
 */
export function distributeExact(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new Error('total must not be negative');
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0n)) throw new Error('weights must not be negative');
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new Error('weights must not all be zero');

  const parts = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let leftover = total - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    parts[i] = parts[i]! + 1n;
    leftover -= 1n;
  }
  return parts;
}

export interface FollowerAllocation {
  id: string;
  allocationBps: number;
}

export interface FollowerFill {
  id: string;
  size: bigint;
  /** Numerator dropped by the floor, out of 10_000. Reported, not reallocated. */
  remainder: bigint;
}

/**
 * One leader trade across many followers. Each follower gets their own floor;
 * nothing is redistributed between followers, because a follower's size is a
 * fixed fraction of the leader's, not a share of a pool.
 */
export function allocateLeaderTrade(
  leaderSize: bigint,
  followers: readonly FollowerAllocation[],
): FollowerFill[] {
  return followers.map((f) => ({
    id: f.id,
    size: mirrorSize(leaderSize, f.allocationBps),
    remainder: mirrorRemainder(leaderSize, f.allocationBps),
  }));
}

export interface FollowPreview {
  /** The worked example the follow sheet prints. */
  leaderSize: bigint;
  followerSize: bigint;
  /** A close at `+exampleMoveBps` from entry, for a long. */
  exampleProfit: bigint;
  fee: bigint;
  followerNet: bigint;
  /** The same move the other way: no fee. */
  exampleLoss: bigint;
}

/**
 * A worked example of the terms: "if the leader opens `leaderSize` and it
 * closes `moveBps` above entry, you mirror this much and pay this fee; if it
 * closes `moveBps` below, you pay no fee". Real arithmetic, not a marketing
 * figure: the same functions the contract's numbers are checked against.
 */
export function previewFollow(input: {
  terms: CopyTerms;
  leaderSize: bigint;
  /** Price move for the example, in bps of entry. */
  moveBps: number;
}): FollowPreview {
  const { terms, leaderSize, moveBps } = input;
  const entryPrice = 1_000_000n;
  const followerSize = mirrorSize(leaderSize, terms.allocationBps);
  const up = entryPrice + (entryPrice * BigInt(moveBps)) / BPS;
  const down = entryPrice - (entryPrice * BigInt(moveBps)) / BPS;
  const exampleProfit = mirrorPnl({ followerSize, entryPrice, exitPrice: up, isLong: true });
  const exampleLoss = mirrorPnl({ followerSize, entryPrice, exitPrice: down, isLong: true });
  const { fee, followerNet } = splitProfit(exampleProfit, terms.feeShareBps);
  return { leaderSize, followerSize, exampleProfit, fee, followerNet, exampleLoss };
}
