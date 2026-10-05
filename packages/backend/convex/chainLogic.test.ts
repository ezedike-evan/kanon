import { describe, expect, it } from "vitest";
import { toFunctionSelector, toEventSelector } from "viem";
import { vaultAssetId } from "@kanon/spec";
import {
  SELECTORS,
  SIDE_TAKEN_TOPIC,
  decodeAddress,
  decodeBool,
  decodeUint,
  encodeAddressCall,
  padAddress,
  padUint,
  receiptConfirms,
  verifyPositionReceipt,
  verifyVaultMirror,
  verifyCopyVaultMirror,
  type CopyVaultReads,
  type RpcReceipt,
  type VaultReads,
} from "./chainLogic";

const MARKET = "0x00000000000000000000000000000000000000aa";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

it("selectors and topics match the contracts' signatures", () => {
  expect(SIDE_TAKEN_TOPIC).toBe(toEventSelector("SideTaken(uint256,address,bool,uint256)"));
  expect(SELECTORS.isVault).toBe(toFunctionSelector("isVault(address)"));
  expect(SELECTORS.owner).toBe(toFunctionSelector("owner()"));
  expect(SELECTORS.strategyExecutor).toBe(toFunctionSelector("strategyExecutor()"));
  expect(SELECTORS.maxDailyDrawdownBps).toBe(toFunctionSelector("maxDailyDrawdownBps()"));
  expect(SELECTORS.totalCollateral).toBe(toFunctionSelector("totalCollateral()"));
  expect(SELECTORS.whitelistedAssetIds).toBe(toFunctionSelector("whitelistedAssetIds(uint256)"));
  expect(SELECTORS.isCopyVault).toBe(toFunctionSelector("isCopyVault(address)"));
  expect(SELECTORS.follower).toBe(toFunctionSelector("follower()"));
  expect(SELECTORS.leaderExecutor).toBe(toFunctionSelector("leaderExecutor()"));
  expect(SELECTORS.allocationBps).toBe(toFunctionSelector("allocationBps()"));
  expect(SELECTORS.feeShareBps).toBe(toFunctionSelector("feeShareBps()"));
  expect(SELECTORS.feeRecipient).toBe(toFunctionSelector("feeRecipient()"));
  expect(SELECTORS.leaderStrategyId).toBe(toFunctionSelector("leaderStrategyId()"));
});

const sideTaken = (o: { market?: string; id?: bigint; staker?: string; yes?: boolean; amount?: bigint }) => ({
  address: o.market ?? MARKET,
  topics: [SIDE_TAKEN_TOPIC, padUint(o.id ?? 7n), padAddress(o.staker ?? WALLET)],
  data: "0x" + padUint(o.yes === false ? 0n : 1n).slice(2) + padUint(o.amount ?? 5_000_000_000_000_000_000n).slice(2),
});
const receipt = (over: Partial<RpcReceipt> = {}): RpcReceipt => ({
  status: "0x1",
  to: MARKET,
  from: WALLET,
  logs: [sideTaken({})],
  ...over,
});
const verify = (r: RpcReceipt | null, direction: "above" | "below" = "above", wallet = WALLET) =>
  verifyPositionReceipt({ receipt: r, marketAddress: MARKET, chainMarketId: "7", wallet, direction });

describe("verifyPositionReceipt", () => {
  it("derives stake and side from the log", () => {
    const v = verify(receipt());
    expect(v).toEqual({ ok: true, stake: { atoms: "5000000000000000000", decimals: 18 }, side: "above", takesYes: true });
  });

  it("maps a NO stake to the opposite price side", () => {
    const r = receipt({ logs: [sideTaken({ yes: false })] });
    expect(verify(r, "above")).toMatchObject({ ok: true, side: "below", takesYes: false });
    expect(verify(r, "below")).toMatchObject({ ok: true, side: "above" });
  });

  it("is case-insensitive about addresses", () => {
    const r = receipt({ to: MARKET.toUpperCase().replace("0X", "0x"), from: WALLET.toUpperCase().replace("0X", "0x") });
    expect(verify(r).ok).toBe(true);
  });

  it.each([
    ["no receipt", null],
    ["reverted", receipt({ status: "0x0" })],
    ["wrong contract", receipt({ to: OTHER })],
    ["contract creation", receipt({ to: null })],
    ["sent by someone else", receipt({ from: OTHER })],
    ["no log", receipt({ logs: [] })],
    ["log from another contract", receipt({ logs: [sideTaken({ market: OTHER })] })],
    ["log for another market", receipt({ logs: [sideTaken({ id: 8n })] })],
    ["log for another staker", receipt({ logs: [sideTaken({ staker: OTHER })] })],
    ["zero amount", receipt({ logs: [sideTaken({ amount: 0n })] })],
    ["two matching logs", receipt({ logs: [sideTaken({}), sideTaken({})] })],
    ["short data", receipt({ logs: [{ ...sideTaken({}), data: "0x01" }] })],
    ["non-bool flag", receipt({ logs: [{ ...sideTaken({}), data: "0x" + padUint(2n).slice(2) + padUint(1n).slice(2) }] })],
  ])("refuses: %s", (_name, r) => {
    expect(verify(r as RpcReceipt | null).ok).toBe(false);
  });

  it("refuses a missing on-chain market id", () => {
    expect(
      verifyPositionReceipt({ receipt: receipt(), marketAddress: MARKET, chainMarketId: "abc", wallet: WALLET, direction: "above" }).ok,
    ).toBe(false);
  });
});

describe("decoders", () => {
  it("decodes uint, bool and address words", () => {
    expect(decodeUint(padUint(42n))).toBe(42n);
    expect(decodeBool(padUint(1n))).toBe(true);
    expect(decodeBool(padUint(0n))).toBe(false);
    expect(decodeBool(padUint(2n))).toBeNull();
    expect(decodeAddress(padAddress(WALLET))).toBe(WALLET);
    expect(decodeAddress("0x" + "ff".repeat(32))).toBeNull();
    expect(decodeUint("0x")).toBeNull();
    expect(decodeUint(undefined)).toBeNull();
  });
  it("encodes address calldata", () => {
    expect(encodeAddressCall(SELECTORS.isVault, WALLET)).toBe(SELECTORS.isVault + "0".repeat(24) + "1".repeat(40));
  });
});

describe("verifyVaultMirror", () => {
  const ids = [vaultAssetId("BTC/USD")].map((x) => x.toLowerCase());
  const reads: VaultReads = { isVault: true, owner: WALLET, executor: OTHER, maxDailyDrawdownBps: 500n, assetIds: ids };
  const claimed = { executor: OTHER, maxDailyDrawdownBps: 500, assetIds: ids };
  const v = (r: Partial<VaultReads> = {}, c: Partial<typeof claimed> = {}, wallet = WALLET) =>
    verifyVaultMirror({ reads: { ...reads, ...r }, wallet, claimed: { ...claimed, ...c } });

  it("accepts a vault that matches the chain", () => expect(v().ok).toBe(true));
  it("refuses a non-vault", () => expect(v({ isVault: false }).ok).toBe(false));
  it("refuses a vault another wallet owns", () => expect(v({}, {}, OTHER).ok).toBe(false));
  it("refuses a wrong executor, drawdown or whitelist", () => {
    expect(v({}, { executor: WALLET }).ok).toBe(false);
    expect(v({}, { maxDailyDrawdownBps: 900 }).ok).toBe(false);
    expect(v({}, { assetIds: [] }).ok).toBe(false);
    expect(v({ assetIds: [...ids, "0x" + "ab".repeat(32)] }).ok).toBe(false);
  });
  it("refuses unreadable fields", () => {
    expect(v({ owner: null }).ok).toBe(false);
    expect(v({ maxDailyDrawdownBps: null }).ok).toBe(false);
  });
});

describe("receiptConfirms", () => {
  it("needs success and the right target", () => {
    expect(receiptConfirms(receipt(), MARKET)).toBe(true);
    expect(receiptConfirms(receipt(), OTHER)).toBe(false);
    expect(receiptConfirms(receipt({ status: "0x0" }), MARKET)).toBe(false);
    expect(receiptConfirms(null, MARKET)).toBe(false);
  });
});

describe("verifyCopyVaultMirror", () => {
  const FEE = "0x" + "3".repeat(40);
  const reads: CopyVaultReads = {
    isCopyVault: true,
    follower: WALLET,
    leaderExecutor: OTHER,
    feeRecipient: FEE,
    allocationBps: 2500n,
    feeShareBps: 1000n,
    leaderStrategyId: 9n,
  };
  const lead = { leaderExecutor: OTHER, feeRecipient: FEE, chainStrategyId: "9" as string | null };
  const v = (r: Partial<CopyVaultReads> = {}, l: Partial<typeof lead> = {}, wallet = WALLET) =>
    verifyCopyVaultMirror({ reads: { ...reads, ...r }, wallet, lead: { ...lead, ...l } });

  it("accepts a vault that matches the chain and returns the chain's terms", () => {
    expect(v()).toEqual({ ok: true, allocationBps: 2500, feeShareBps: 1000 });
  });
  it("refuses a non-copy-vault", () => expect(v({ isCopyVault: false }).ok).toBe(false));
  it("refuses another wallet's vault", () => expect(v({}, {}, OTHER).ok).toBe(false));
  it("refuses a different executor, fee address or strategy", () => {
    expect(v({ leaderExecutor: FEE }).ok).toBe(false);
    expect(v({ feeRecipient: OTHER }).ok).toBe(false);
    expect(v({ leaderStrategyId: 10n }).ok).toBe(false);
  });
  it("refuses a lead with no registry entry", () => expect(v({}, { chainStrategyId: null }).ok).toBe(false));
  it("refuses unreadable or out-of-range terms", () => {
    expect(v({ allocationBps: null }).ok).toBe(false);
    expect(v({ allocationBps: 0n }).ok).toBe(false);
    expect(v({ feeShareBps: 10_001n }).ok).toBe(false);
  });
});
