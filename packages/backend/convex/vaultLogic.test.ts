import { describe, expect, it } from "vitest";
import { VAULT_LOOSENING_HOLD_SECONDS } from "@kanon/spec";
import {
  decideVaultChange,
  equityPointsFromRows,
  guardFromRows,
  isAddress,
  isTxHash,
  normalizeAddress,
  validateFollow,
  validateListing,
  validateVaultRecord,
} from "./vaultLogic";

const ADDR = "0x" + "ab".repeat(20);
const TX = "0x" + "cd".repeat(32);
const limits = (assets: string[], bps: number) => ({ assets, maxDailyDrawdownBps: bps });
const HOLD_MS = VAULT_LOOSENING_HOLD_SECONDS * 1000;

describe("addresses", () => {
  it("recognises 20-byte and 32-byte hex", () => {
    expect(isAddress(ADDR)).toBe(true);
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress(undefined)).toBe(false);
    expect(isTxHash(TX)).toBe(true);
    expect(isTxHash(ADDR)).toBe(false);
    expect(normalizeAddress("0xAbC")).toBe("0xabc");
  });
});

describe("validateVaultRecord", () => {
  const ok = { ...limits(["BTC/USD"], 200), address: ADDR, chainId: 31337, executor: ADDR, txHash: TX };
  it("accepts a real, signed vault", () => {
    expect(validateVaultRecord(ok)).toEqual([]);
  });
  it("refuses a record with no creating transaction", () => {
    expect(validateVaultRecord({ ...ok, txHash: "" })).toHaveLength(1);
  });
  it("refuses bad limits, addresses and chain ids", () => {
    expect(validateVaultRecord({ ...ok, assets: [], address: "nope", chainId: 0 }).length).toBe(3);
  });
});

describe("decideVaultChange", () => {
  const current = limits(["BTC/USD", "ETH/USD"], 300);
  const now = 1_700_000_000_000;

  it("does nothing when nothing changed", () => {
    expect(decideVaultChange({ current, requested: current, pending: null, nowMs: now })).toEqual({ action: "none" });
  });

  it("applies a tightening at once, even with a loosening pending", () => {
    const pending = { limits: limits(["BTC/USD", "ETH/USD", "SOL/USD"], 500), requestedAt: now, endsAt: now + HOLD_MS };
    const d = decideVaultChange({ current, requested: limits(["BTC/USD"], 100), pending, nowMs: now + 1 });
    expect(d).toEqual({ action: "apply", reason: "tightening" });
  });

  it("stages a loosening and starts the hold", () => {
    const d = decideVaultChange({ current, requested: limits(["BTC/USD", "ETH/USD"], 500), pending: null, nowMs: now });
    expect(d.action).toBe("stage");
    if (d.action === "stage") {
      expect(d.pending.endsAt).toBe(now + HOLD_MS);
    }
  });

  it("makes the same request wait, with the remaining time, until the hold has run", () => {
    const requested = limits(["BTC/USD", "ETH/USD"], 500);
    const pending = { limits: requested, requestedAt: now, endsAt: now + HOLD_MS };
    const d = decideVaultChange({ current, requested, pending, nowMs: now + 1000 });
    expect(d).toMatchObject({ action: "wait", remainingMs: HOLD_MS - 1000 });
    const almost = decideVaultChange({ current, requested, pending, nowMs: now + HOLD_MS - 1 });
    expect(almost.action).toBe("wait");
  });

  it("applies once the hold has fully run, on the boundary", () => {
    const requested = limits(["BTC/USD", "ETH/USD"], 500);
    const pending = { limits: requested, requestedAt: now, endsAt: now + HOLD_MS };
    expect(decideVaultChange({ current, requested, pending, nowMs: now + HOLD_MS })).toEqual({
      action: "apply",
      reason: "hold_elapsed",
    });
  });

  it("asking for different loose limits restarts the hold; there is no shortcut", () => {
    const pending = { limits: limits(["BTC/USD", "ETH/USD"], 500), requestedAt: now, endsAt: now + HOLD_MS };
    const d = decideVaultChange({
      current,
      requested: limits(["BTC/USD", "ETH/USD"], 600),
      pending,
      nowMs: now + HOLD_MS + 10,
    });
    expect(d.action).toBe("stage");
    if (d.action === "stage") expect(d.pending.requestedAt).toBe(now + HOLD_MS + 10);
  });

  it("treats a mixed edit as a loosening", () => {
    expect(
      decideVaultChange({ current, requested: limits(["BTC/USD", "SOL/USD"], 100), pending: null, nowMs: now }).action,
    ).toBe("stage");
  });

  it("returns problems for invalid limits instead of throwing", () => {
    const d = decideVaultChange({ current, requested: limits([], 0), pending: null, nowMs: now });
    expect(d.action).toBe("invalid");
  });
});

describe("guardFromRows", () => {
  it("reads stored string atoms as bigint and evaluates the guard", () => {
    const day = 20_000 * 86_400;
    const rows = [
      { at: day + 5, equityAtoms: "1000000000", realizedPnlAtoms: "-5000000" },
      { at: day + 60, equityAtoms: "1000000000", realizedPnlAtoms: "-3000000" },
    ];
    expect(equityPointsFromRows(rows)[0]?.equity).toBe(1_000_000_000n);
    const g = guardFromRows({ rows, nowSeconds: day + 100, currentEquityAtoms: "992000000", maxDailyDrawdownBps: 200 });
    expect(g.referenceBalance).toBe(1_000_000_000n);
    expect(g.realizedToday).toBe(-8_000_000n);
    expect(g.lossBudget).toBe(20_000_000n);
    expect(g.remaining).toBe(12_000_000n);
    expect(g.usedBps).toBe(80);
  });
});

describe("validateFollow", () => {
  const lead = { profitShareBps: 1000, leaderExecutor: ADDR, feeRecipient: ADDR, active: true };
  it("accepts terms that match the listing", () => {
    expect(validateFollow({ terms: { allocationBps: 2500, feeShareBps: 1000 }, lead })).toEqual([]);
  });
  it("refuses a fee the lead did not list, in either direction", () => {
    expect(validateFollow({ terms: { allocationBps: 2500, feeShareBps: 0 }, lead })).toHaveLength(1);
    expect(validateFollow({ terms: { allocationBps: 2500, feeShareBps: 2000 }, lead })).toHaveLength(1);
  });
  it("refuses out-of-range allocation, a delisted lead, or a lead without addresses", () => {
    expect(validateFollow({ terms: { allocationBps: 0, feeShareBps: 1000 }, lead })).toHaveLength(1);
    expect(validateFollow({ terms: { allocationBps: 100, feeShareBps: 1000 }, lead: { ...lead, active: false } })).toHaveLength(1);
    expect(
      validateFollow({ terms: { allocationBps: 100, feeShareBps: 1000 }, lead: { ...lead, leaderExecutor: "", feeRecipient: "" } }),
    ).toHaveLength(2);
  });
});

describe("validateListing", () => {
  it("accepts a well-formed listing and refuses a bad share or address", () => {
    expect(validateListing({ profitShareBps: 1500, leaderExecutor: ADDR, feeRecipient: ADDR })).toEqual([]);
    expect(validateListing({ profitShareBps: 10_001, leaderExecutor: ADDR, feeRecipient: ADDR })).toHaveLength(1);
    expect(validateListing({ profitShareBps: 100, leaderExecutor: "x", feeRecipient: "y" })).toHaveLength(2);
  });
});
