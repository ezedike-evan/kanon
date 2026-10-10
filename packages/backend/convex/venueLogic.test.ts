import { describe, expect, it } from "vitest";
import { BeginBody, ORDER_LOCK_MS, SettleBody, isLocked, recorderKeyMatches } from "./venueLogic";

describe("isLocked", () => {
  const now = 1_000_000;
  it("holds while an order is still being sent, and lets go of one that never reported back", () => {
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(now, now)).toBe(true);
    expect(isLocked(now - ORDER_LOCK_MS + 1, now)).toBe(true);
    expect(isLocked(now - ORDER_LOCK_MS, now)).toBe(false);
  });
  it("does not lock on a row stamped in the future", () => {
    expect(isLocked(now + 5_000, now)).toBe(false);
  });
});

describe("recorderKeyMatches", () => {
  const key = "k".repeat(31) + "Z";
  it("takes the key and nothing else", () => {
    expect(recorderKeyMatches(key, key)).toBe(true);
    expect(recorderKeyMatches("k".repeat(32), key)).toBe(false);
    expect(recorderKeyMatches(key + "Z", key)).toBe(false);
    expect(recorderKeyMatches(key.slice(0, 31), key)).toBe(false);
    expect(recorderKeyMatches(key.toLowerCase(), key)).toBe(false);
  });
  it("turns away a missing or empty one", () => {
    expect(recorderKeyMatches(null, key)).toBe(false);
    expect(recorderKeyMatches(undefined, key)).toBe(false);
    expect(recorderKeyMatches("", key)).toBe(false);
  });
});

describe("BeginBody", () => {
  it("reads an open and a close", () => {
    const open = { network: "testnet", asset: "BTC/USD", action: "open", side: "long", notionalUsd: 25, leverage: 2 };
    expect(BeginBody.parse(open)).toEqual(open);
    expect(BeginBody.parse({ network: "testnet", asset: "BTC/USD", action: "close" })).toEqual({
      network: "testnet",
      asset: "BTC/USD",
      action: "close",
    });
  });
  it("takes no field that names a user, and no other extra", () => {
    const base = { network: "testnet", asset: "BTC/USD", action: "close" };
    expect(BeginBody.safeParse({ ...base, subject: "did:privy:someone-else" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...base, userId: "abc" }).success).toBe(false);
  });
  it("turns away a network, action or size it does not know", () => {
    const base = { network: "testnet", asset: "BTC/USD", action: "open" };
    expect(BeginBody.safeParse({ ...base, network: "prod" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...base, action: "flip" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...base, notionalUsd: 12.5 }).success).toBe(false);
    expect(BeginBody.safeParse({ ...base, leverage: 0 }).success).toBe(false);
  });
});

describe("SettleBody", () => {
  it("reads a fill with its figures as integers and their scale", () => {
    const fill = {
      orderId: "k17abc",
      status: "filled",
      side: "short",
      requestId: 3,
      size: { atoms: "12", decimals: 5 },
      fillPrice: { atoms: "827329", decimals: 1 },
      fee: { atoms: "-8575", decimals: 6 },
      block: 69809281,
      txHash: "0x" + "0405deeb".repeat(8),
    };
    expect(SettleBody.parse(fill)).toEqual(fill);
  });
  it("turns away a float where an integer belongs, and a hash that is not one", () => {
    const base = { orderId: "k17abc", status: "filled" };
    expect(SettleBody.safeParse({ ...base, size: { atoms: "0.5", decimals: 5 } }).success).toBe(false);
    expect(SettleBody.safeParse({ ...base, txHash: "0x1234" }).success).toBe(false);
    expect(SettleBody.safeParse({ ...base, status: "submitting" }).success).toBe(false);
  });
});
