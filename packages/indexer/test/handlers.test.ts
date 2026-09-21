import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";

type Hex = `0x${string}`;
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;

// Placeholder deployment addresses from config.yaml (the simulate default).
const MARGIN = addr(4);
const FACTORY = addr(6);
const SERIES = addr(7);
// Dynamic vault, created through the factory below, plus the people around it.
const VAULT = addr(0x5a);
const COPY_VAULT = addr(0x5b);
const OWNER = addr(0xaa);
const EXECUTOR = addr(0xee);
const LIQUIDATOR = addr(0xbb);
const SPEC_A = `0x${"a1".repeat(32)}`;
const SPEC_B = `0x${"b2".repeat(32)}`;
const COMMIT_A = `0x${"c1".repeat(32)}`;
const COMMIT_B = `0x${"c2".repeat(32)}`;
const SERIES_B = addr(8);
const BOS = "0x626f735f6c6f6e67000000000000000000000000000000000000000000000000"; // "bos_long"

const createGuardedVault = (block: number) =>
  ({
    contract: "VaultFactory",
    event: "GuardedVaultCreated",
    block: { number: block, timestamp: block * 100 },
    transaction: tx(`0xc0ffee${block}`),
    params: {
      vault: VAULT,
      owner: OWNER,
      strategyId: 0n,
      strategyExecutor: EXECUTOR,
      series: SERIES,
      maxDailyDrawdownBps: 500n,
      whitelistedAssetIds: [`0x${"cc".repeat(32)}`],
    },
  }) as const;

const tx = (hash: string, from: Hex = OWNER) => ({ hash, from });

describe("strategy timeline", () => {
  it("records pin, loosening cooling-off and the tighten that cancels it, with commitment and series", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "StrategyRegistry",
              event: "StrategyPinned",
              block: { number: 10, timestamp: 1000 },
              transaction: tx("0x01"),
              params: { strategyId: 0n, owner: OWNER, specHash: SPEC_A, bond: 5n, predicatesCommitment: COMMIT_A, series: SERIES },
            },
            {
              contract: "StrategyRegistry",
              event: "LooseningProposed",
              block: { number: 11, timestamp: 2000 },
              transaction: tx("0x02"),
              params: {
                strategyId: 0n,
                pendingSpecHash: SPEC_B,
                pendingPredicatesCommitment: COMMIT_B,
                pendingSeries: SERIES_B,
                cooldownEndsAt: 9000n,
              },
            },
          ],
        },
      },
    });

    const pending = await indexer.Strategy.getOrThrow("143_0");
    expect(pending).toMatchObject({
      activeSpecHash: SPEC_A,
      predicatesCommitment: COMMIT_A,
      series: SERIES,
      pendingSpecHash: SPEC_B,
      pendingPredicatesCommitment: COMMIT_B,
      pendingSeries: SERIES_B,
      cooldownEndsAt: 9000,
    });

    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "StrategyRegistry",
              event: "Tightened",
              block: { number: 12, timestamp: 3000 },
              transaction: tx("0x03"),
              params: {
                strategyId: 0n,
                oldSpecHash: SPEC_A,
                newSpecHash: SPEC_B,
                newPredicatesCommitment: COMMIT_B,
                newSeries: SERIES,
              },
            },
          ],
        },
      },
    });

    const tightened = await indexer.Strategy.getOrThrow("143_0");
    expect(tightened).toMatchObject({ activeSpecHash: SPEC_B, predicatesCommitment: COMMIT_B, series: SERIES, tightenCount: 1, looseningCount: 1 });
    expect(tightened.pendingSpecHash).toBeUndefined();
    expect(tightened.pendingPredicatesCommitment).toBeUndefined();
    expect(tightened.pendingSeries).toBeUndefined();

    const events = (await indexer.StrategyEvent.getAll()).sort((a, b) => a.timestamp - b.timestamp);
    expect(events.map((e) => e.kind)).toEqual(["PINNED", "LOOSENING_PROPOSED", "TIGHTENED"]);
    expect(events[1]).toMatchObject({ predicatesCommitment: COMMIT_B, series: SERIES_B, oldPredicatesCommitment: COMMIT_A, oldSeries: SERIES });
    expect(events[2]).toMatchObject({ oldPredicatesCommitment: COMMIT_A, predicatesCommitment: COMMIT_B });
  });

  it("applies a finalized loosening to the active spec, commitment and series", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "StrategyRegistry",
              event: "StrategyPinned",
              block: { number: 10, timestamp: 1000 },
              transaction: tx("0x01"),
              params: { strategyId: 1n, owner: OWNER, specHash: SPEC_A, bond: 5n, predicatesCommitment: COMMIT_A, series: SERIES },
            },
            {
              contract: "StrategyRegistry",
              event: "LooseningProposed",
              block: { number: 11, timestamp: 2000 },
              transaction: tx("0x02"),
              params: { strategyId: 1n, pendingSpecHash: SPEC_B, pendingPredicatesCommitment: COMMIT_B, pendingSeries: SERIES_B, cooldownEndsAt: 3000n },
            },
            {
              contract: "StrategyRegistry",
              event: "LooseningFinalized",
              block: { number: 12, timestamp: 3100 },
              transaction: tx("0x03", LIQUIDATOR),
              params: { strategyId: 1n, oldSpecHash: SPEC_A, newSpecHash: SPEC_B, newPredicatesCommitment: COMMIT_B, newSeries: SERIES_B },
            },
          ],
        },
      },
    });
    const s = await indexer.Strategy.getOrThrow("143_1");
    expect(s).toMatchObject({ activeSpecHash: SPEC_B, predicatesCommitment: COMMIT_B, series: SERIES_B, looseningCount: 1 });
    expect(s.pendingSpecHash).toBeUndefined();
    expect(s.cooldownEndsAt).toBeUndefined();
    const fin = (await indexer.StrategyEvent.getAll()).find((e) => e.kind === "LOOSENING_FINALIZED");
    expect(fin).toMatchObject({ actor: LIQUIDATOR, oldSeries: SERIES, series: SERIES_B });
  });
});

describe("refusals", () => {
  it("stores a gate refusal with predicate, failing value and evidence", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "StrategyRegistry",
              event: "StrategyPinned",
              block: { number: 1, timestamp: 100 },
              transaction: tx("0x10"),
              params: { strategyId: 3n, owner: OWNER, specHash: SPEC_A, bond: 1n, predicatesCommitment: COMMIT_A, series: SERIES },
            },
            {
              contract: "RefusalGate",
              event: "TradeRefused",
              block: { number: 2, timestamp: 200 },
              logIndex: 4,
              transaction: tx("0xdead"),
              params: { strategyId: 3n, specHash: SPEC_A, proposer: OWNER, predicateSymbol: BOS, decidingValue: -42n },
            },
          ],
        },
      },
    });

    const refusals = await indexer.Refusal.getAll();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      strategy_id: "143_3",
      specHash: SPEC_A,
      proposer: OWNER,
      account: OWNER,
      predicate: "bos_long",
      decidingValue: -42n,
      timestamp: 200,
      blockNumber: 2,
      logIndex: 4,
      txHash: "0xdead",
    });

    const logs = await indexer.TradeLog.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "REFUSED", reason: "bos_long", txHash: "0xdead", specHash: SPEC_A });

    expect((await indexer.Strategy.getOrThrow("143_3")).refusalCount).toBe(1);
    expect((await indexer.Account.getOrThrow(`143_${OWNER}`)).refusalCount).toBe(1);
  });

  it("merges a GuardedVault predicate refusal into the gate row and attributes it to the owner", async () => {
    const indexer = createTestIndexer();
    const reason = `0x${Buffer.from("PREDICATE_NOT_SATISFIED").toString("hex").padEnd(64, "0")}`;
    await indexer.process({
      chains: {
        143: {
          simulate: [
            createGuardedVault(1),
            {
              contract: "RefusalGate",
              event: "TradeRefused",
              block: { number: 5, timestamp: 500 },
              logIndex: 1,
              transaction: tx("0xbeef", EXECUTOR),
              params: { strategyId: 0n, specHash: SPEC_A, proposer: VAULT, predicateSymbol: BOS, decidingValue: 7n },
            },
            {
              contract: "GuardedVault",
              event: "TradeRefused",
              srcAddress: VAULT,
              block: { number: 5, timestamp: 500 },
              logIndex: 2,
              transaction: tx("0xbeef", EXECUTOR),
              params: { assetId: `0x${"cc".repeat(32)}`, proposer: EXECUTOR, reason, decidingValue: 0n },
            },
          ],
        },
      },
    });

    const refusals = await indexer.Refusal.getAll();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      proposer: VAULT,
      account: OWNER,
      actor: EXECUTOR,
      vault: VAULT,
      predicate: "bos_long",
    });

    const logs = (await indexer.TradeLog.getAll()).filter((l) => l.kind === "REFUSED");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ account: OWNER, actor: EXECUTOR, vault: VAULT, decidingValue: 7n, reason: "bos_long" });

    // The trade counts once, against the owner, not also against the vault contract.
    expect((await indexer.Account.getOrThrow(`143_${OWNER}`)).refusalCount).toBe(1);
    expect((await indexer.Account.getOrThrow(`143_${VAULT}`)).refusalCount).toBe(0);
    expect((await indexer.Vault.getOrThrow(`143_${VAULT}`)).refusalCount).toBe(1);
  });

  it("merges a GuardedVault accepted proposal the same way", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            createGuardedVault(1),
            {
              contract: "RefusalGate",
              event: "TradeProposed",
              block: { number: 8, timestamp: 800 },
              logIndex: 0,
              transaction: tx("0xace", EXECUTOR),
              params: { strategyId: 0n, specHash: SPEC_A, proposer: VAULT },
            },
            {
              contract: "GuardedVault",
              event: "TradeProposed",
              srcAddress: VAULT,
              block: { number: 8, timestamp: 800 },
              logIndex: 1,
              transaction: tx("0xace", EXECUTOR),
              params: { assetId: `0x${"cc".repeat(32)}`, proposer: EXECUTOR, isLong: true, size: 50n, projectedPnL: -3n },
            },
          ],
        },
      },
    });
    const logs = (await indexer.TradeLog.getAll()).filter((l) => l.kind === "PROPOSED");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ account: OWNER, actor: EXECUTOR, vault: VAULT, size: 50n, pnl: -3n, specHash: SPEC_A });
    expect((await indexer.Account.getOrThrow(`143_${OWNER}`)).proposalCount).toBe(1);
    expect((await indexer.Strategy.get("143_0"))?.proposalCount ?? 0).toBe(0);
  });

  it("records a whitelist refusal that never reached the gate", async () => {
    const indexer = createTestIndexer();
    const reason = `0x${Buffer.from("ASSET_NOT_WHITELISTED").toString("hex").padEnd(64, "0")}`;
    await indexer.process({
      chains: {
        143: {
          simulate: [
            createGuardedVault(1),
            {
              contract: "GuardedVault",
              event: "TradeRefused",
              srcAddress: VAULT,
              block: { number: 6, timestamp: 600 },
              transaction: tx("0xfeed"),
              params: { assetId: `0x${"dd".repeat(32)}`, proposer: OWNER, reason, decidingValue: 0n },
            },
          ],
        },
      },
    });
    const logs = await indexer.TradeLog.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "REFUSED", contractName: "GuardedVault", reason: "ASSET_NOT_WHITELISTED" });
    expect(await indexer.Refusal.getAll()).toHaveLength(0);
  });
});

describe("positions and prices", () => {
  it("opens then liquidates a margin position", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "MarginAccount",
              event: "PositionOpened",
              block: { number: 20, timestamp: 2000 },
              transaction: tx("0x20"),
              params: { account: OWNER, positionId: 0n, seriesContract: SERIES, isLong: true, size: 10n, entryPrice: 100n },
            },
            {
              contract: "MarginAccount",
              event: "PositionClosed",
              block: { number: 21, timestamp: 2100 },
              transaction: tx("0x21", LIQUIDATOR),
              params: { account: OWNER, positionId: 0n, exitPrice: 90n, pnl: -100n, wasLiquidation: true },
            },
          ],
        },
      },
    });
    const pos = await indexer.Position.getOrThrow(`143_${MARGIN}_${OWNER}_0`);
    expect(pos).toMatchObject({ status: "LIQUIDATED", exitPrice: 90n, pnl: -100n, liquidator: LIQUIDATOR });
    const kinds = (await indexer.TradeLog.getAll()).map((l) => l.kind).sort();
    expect(kinds).toEqual(["LIQUIDATED", "OPENED"]);
    expect((await indexer.Account.getOrThrow(`143_${OWNER}`)).liquidationCount).toBe(1);
  });

  it("stores price samples with exact integer price and exponent", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "CanonicalSeries",
              event: "SampleRecorded",
              block: { number: 30, timestamp: 3000 },
              transaction: tx("0x30"),
              params: { bucketIndex: 4n, price: 6543210987654n, expo: -8n, publishTime: 2990n, caller: OWNER },
            },
          ],
        },
      },
    });
    const [sample] = await indexer.PriceSample.getAll();
    expect(sample).toMatchObject({ price: 6543210987654n, expo: -8, publishTime: 2990, bucketIndex: "4" });
  });
});

describe("ThresholdMarket", () => {
  it("tracks stakes per side through settlement", async () => {
    const indexer = createTestIndexer();
    const SERIES_ID = `0x${"ee".repeat(32)}`;
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "ThresholdMarket",
              event: "MarketOpened",
              block: { number: 40, timestamp: 4000 },
              transaction: tx("0x40"),
              params: { marketId: 0n, seriesId: SERIES_ID, thresholdPrice: 100n, above: true, windowStart: 4000n, windowEnd: 5000n },
            },
            {
              contract: "ThresholdMarket",
              event: "SideTaken",
              block: { number: 41, timestamp: 4100 },
              transaction: tx("0x41"),
              params: { marketId: 0n, staker: OWNER, takesYes: true, amount: 30n },
            },
            {
              contract: "ThresholdMarket",
              event: "SideTaken",
              block: { number: 42, timestamp: 4200 },
              transaction: tx("0x42"),
              params: { marketId: 0n, staker: OWNER, takesYes: false, amount: 20n },
            },
            {
              contract: "ThresholdMarket",
              event: "MarketSettled",
              block: { number: 43, timestamp: 5100 },
              transaction: tx("0x43"),
              params: { marketId: 0n, yesWon: true },
            },
          ],
        },
      },
    });
    const market = await indexer.Market.getOrThrow(`143_${addr(3)}_0`);
    expect(market).toMatchObject({ status: "SETTLED", yesWon: true, yesStake: 30n, noStake: 20n, betCount: 2 });
  });
});

describe("VaultFactory", () => {
  it("records the guarded vault's immutable config and owner", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 143: { simulate: [createGuardedVault(2)] } } });
    const vault = await indexer.Vault.getOrThrow(`143_${VAULT}`);
    expect(vault).toMatchObject({
      kind: "GUARDED",
      ownerAddress: OWNER,
      executor: EXECUTOR,
      series: SERIES,
      strategy_id: "143_0",
      maxDailyDrawdownBps: 500,
      whitelistedAssetIds: [`0x${"cc".repeat(32)}`],
      factory: FACTORY,
    });
  });

  it("attributes copy-vault trades to the follower, skips included", async () => {
    const indexer = createTestIndexer();
    const skipReason = `0x${Buffer.from("FOLLOWER_INACTIVE").toString("hex").padEnd(64, "0")}`;
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "VaultFactory",
              event: "CopyVaultCreated",
              block: { number: 50, timestamp: 5000 },
              transaction: tx("0x50"),
              params: {
                vault: COPY_VAULT,
                follower: OWNER,
                leaderStrategyId: 2n,
                leaderExecutor: EXECUTOR,
                allocationBps: 1000n,
                feeShareBps: 200n,
                feeRecipient: addr(0xfe),
              },
            },
            {
              contract: "CopyVault",
              event: "PositionMirrored",
              srcAddress: COPY_VAULT,
              block: { number: 51, timestamp: 5100 },
              transaction: tx("0x51"),
              params: { positionId: 0n, assetId: `0x${"cc".repeat(32)}`, isLong: false, followerSize: 5n, entryPrice: 200n },
            },
            {
              contract: "CopyVault",
              event: "PositionClosed",
              srcAddress: COPY_VAULT,
              block: { number: 52, timestamp: 5200 },
              transaction: tx("0x52"),
              params: { positionId: 0n, exitPrice: 180n, pnl: 100n, feeCharged: 20n },
            },
            {
              contract: "CopyVault",
              event: "TradeSkipped",
              srcAddress: COPY_VAULT,
              block: { number: 53, timestamp: 5300 },
              transaction: tx("0x53"),
              params: { assetId: `0x${"cc".repeat(32)}`, reason: skipReason },
            },
          ],
        },
      },
    });
    const vault = await indexer.Vault.getOrThrow(`143_${COPY_VAULT}`);
    expect(vault).toMatchObject({ kind: "COPY", ownerAddress: OWNER, leaderStrategy_id: "143_2", allocationBps: 1000, skippedCount: 1 });
    const pos = await indexer.Position.getOrThrow(`143_${COPY_VAULT}_0`);
    expect(pos).toMatchObject({ status: "CLOSED", exitPrice: 180n, feeCharged: 20n, account: OWNER });
    const logs = (await indexer.TradeLog.getAll()).sort((a, b) => a.timestamp - b.timestamp);
    expect(logs.map((l) => [l.kind, l.account])).toEqual([
      ["MIRRORED", OWNER],
      ["MIRROR_CLOSED", OWNER],
      ["SKIPPED", OWNER],
    ]);
    expect(logs[2]).toMatchObject({ reason: "FOLLOWER_INACTIVE" });
  });
});

describe("MarginAccount risk events and InsuranceFund", () => {
  it("shrinks the position on deleverage and logs the health change", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "MarginAccount",
              event: "PositionOpened",
              block: { number: 60, timestamp: 6000 },
              transaction: tx("0x60"),
              params: { account: OWNER, positionId: 1n, seriesContract: SERIES, isLong: false, size: 100n, entryPrice: 50n },
            },
            {
              contract: "MarginAccount",
              event: "PositionDeleveraged",
              block: { number: 61, timestamp: 6100 },
              transaction: tx("0x61", LIQUIDATOR),
              params: {
                account: OWNER,
                positionId: 1n,
                closedSize: 40n,
                remainingSize: 60n,
                exitPrice: 55n,
                pnl: -20n,
                healthFactorBefore: 1_010n,
                healthFactorAfter: 1_400n,
              },
            },
            {
              contract: "MarginAccount",
              event: "BadDebtResolved",
              block: { number: 62, timestamp: 6200 },
              transaction: tx("0x62"),
              params: { account: OWNER, debt: 30n, coveredByFund: 25n, uncovered: 5n },
            },
            {
              contract: "InsuranceFund",
              event: "ShortfallCovered",
              block: { number: 62, timestamp: 6200 },
              logIndex: 9,
              transaction: tx("0x62"),
              params: { requested: 30n, covered: 25n },
            },
          ],
        },
      },
    });
    const pos = await indexer.Position.getOrThrow(`143_${MARGIN}_${OWNER}_1`);
    expect(pos).toMatchObject({ size: 60n, status: "OPEN" });

    const events = await indexer.MarginEvent.getAll();
    expect(events.map((e) => e.kind).sort()).toEqual(["BAD_DEBT_RESOLVED", "DELEVERAGED"]);
    expect(events.find((e) => e.kind === "DELEVERAGED")).toMatchObject({ healthFactorBefore: 1_010n, healthFactorAfter: 1_400n });
    expect(events.find((e) => e.kind === "BAD_DEBT_RESOLVED")).toMatchObject({ uncovered: 5n });

    const [fund] = await indexer.FundEvent.getAll();
    expect(fund).toMatchObject({ kind: "SHORTFALL_COVERED", requested: 30n, covered: 25n });

    const kinds = (await indexer.TradeLog.getAll()).map((l) => l.kind).sort();
    expect(kinds).toEqual(["DELEVERAGED", "OPENED"]);
  });
});

describe("MarginAccount strategy binding", () => {
  it("records the one-way strategy binding on the account", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "MarginAccount",
              event: "StrategyBound",
              block: { number: 70, timestamp: 7000 },
              transaction: tx("0x70"),
              params: { account: OWNER, strategyId: 4n },
            },
          ],
        },
      },
    });
    expect((await indexer.Account.getOrThrow(`143_${OWNER}`)).boundStrategy_id).toBe("143_4");
    const [ev] = await indexer.MarginEvent.getAll();
    expect(ev).toMatchObject({ kind: "STRATEGY_BOUND", account: OWNER, strategy_id: "143_4", txHash: "0x70" });
  });
});

describe("VaultFactory looser-vault cooling-off", () => {
  it("records the request and when it becomes available", async () => {
    const indexer = createTestIndexer();
    const requestId = `0x${"d4".repeat(32)}`;
    await indexer.process({
      chains: {
        143: {
          simulate: [
            {
              contract: "VaultFactory",
              event: "LooserVaultRequested",
              block: { number: 80, timestamp: 8000 },
              transaction: tx("0x80"),
              params: { owner: OWNER, strategyId: 2n, requestId, availableAt: 90_000n },
            },
          ],
        },
      },
    });
    const [req] = await indexer.LooserVaultRequest.getAll();
    expect(req).toMatchObject({ owner: OWNER, strategy_id: "143_2", requestId, availableAt: 90_000, txHash: "0x80", factory: FACTORY });
  });
});
