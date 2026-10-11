import { describe, expect, it } from "vitest";
import { BeginCloseBody, OwnsBody, StartBody, UpdateBody, mayMoveTo } from "./timedLogic";

const start = {
  network: "testnet",
  asset: "BTC/USD",
  direction: "up",
  stakeUsd: 25,
  leverage: 5,
  seconds: 60,
  openedAt: 1_791_650_000_000,
  expiresAt: 1_791_650_060_000,
  size: { atoms: "30", decimals: 5 },
  entryPrice: { atoms: "828471", decimals: 1 },
};

describe("StartBody", () => {
  it("reads a trade that has opened, with or without its fee and transaction", () => {
    expect(StartBody.parse(start)).toEqual(start);
    const full = { ...start, openFee: { atoms: "8575", decimals: 6 }, openTx: "0x" + "ab".repeat(32) };
    expect(StartBody.parse(full)).toEqual(full);
  });
  it("takes no field that names a user, and no other extra", () => {
    expect(StartBody.safeParse({ ...start, userId: "abc" }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, subject: "did:privy:someone-else" }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, status: "closed" }).success).toBe(false);
  });
  it("turns away a float where an integer belongs, and a direction it does not know", () => {
    expect(StartBody.safeParse({ ...start, size: { atoms: "0.0003", decimals: 5 } }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, stakeUsd: 12.5 }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, direction: "sideways" }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, openTx: "0x1234" }).success).toBe(false);
  });
});

describe("UpdateBody", () => {
  it("reads how a trade ended and the figures that follow", () => {
    const ended = { tradeId: "k17abc", status: "closed", endedBy: "time", closedAt: 1_791_650_060_500 };
    expect(UpdateBody.parse(ended)).toEqual(ended);
    const figures = {
      tradeId: "k17abc",
      exitPrice: { atoms: "828771", decimals: 1 },
      result: { atoms: "-8150", decimals: 6 },
      fees: { atoms: "17150", decimals: 6 },
      closeTx: "0x" + "cd".repeat(32),
    };
    expect(UpdateBody.parse(figures)).toEqual(figures);
  });
  it("cannot reopen a trade, change what was asked for, or move it to another user", () => {
    expect(UpdateBody.safeParse({ tradeId: "k17abc", status: "live" }).success).toBe(false);
    expect(UpdateBody.safeParse({ tradeId: "k17abc", stakeUsd: 1000 }).success).toBe(false);
    expect(UpdateBody.safeParse({ tradeId: "k17abc", entryPrice: { atoms: "1", decimals: 1 } }).success).toBe(false);
    expect(UpdateBody.safeParse({ tradeId: "k17abc", userId: "abc" }).success).toBe(false);
    expect(UpdateBody.safeParse({ tradeId: "k17abc", endedBy: "luck" }).success).toBe(false);
  });
});

describe("the other two bodies", () => {
  it("name a trade and nothing about who is asking", () => {
    expect(BeginCloseBody.parse({ tradeId: "k17abc", network: "testnet", asset: "BTC/USD" })).toEqual({
      tradeId: "k17abc",
      network: "testnet",
      asset: "BTC/USD",
    });
    expect(BeginCloseBody.safeParse({ tradeId: "k17abc", network: "testnet", asset: "BTC/USD", userId: "x" }).success).toBe(false);
    expect(OwnsBody.parse({ tradeId: "k17abc" })).toEqual({ tradeId: "k17abc" });
    expect(OwnsBody.safeParse({ tradeId: "" }).success).toBe(false);
  });
});

describe("mayMoveTo", () => {
  it("lets a running trade close, and never reopens a closed one", () => {
    expect(mayMoveTo("live", "closing")).toBe(true);
    expect(mayMoveTo("live", "closed")).toBe(true);
    expect(mayMoveTo("closing", "closed")).toBe(true);
    expect(mayMoveTo("closing", "closing")).toBe(true);
    expect(mayMoveTo("closed", "closed")).toBe(true);
    expect(mayMoveTo("closed", "closing")).toBe(false);
  });
});
