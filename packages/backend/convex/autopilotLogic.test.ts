import { describe, expect, it } from "vitest";
import { RULE_04 } from "@kanon/spec";
import {
  AUTOPILOT_DURATIONS,
  AUTOPILOT_STAKE_USD,
  BeginBody,
  HANDOFF_EXPIRY_MS,
  HANDOFF_WINDOW_MS,
  ReportBody,
  StartBody,
  candleSecondsOf,
  directionOf,
  handoffExpired,
  holdSecondsFor,
  lastClosedBucket,
  notOpenedPatch,
  openedPatch,
  sameMarket,
  sweepStep,
  withinHandoff,
} from "./autopilotLogic";
import { ORDER_LOCK_MS } from "./venueLogic";

describe("what is opened for a proposal", () => {
  it("stakes the smallest stake on offer", () => {
    expect(AUTOPILOT_STAKE_USD).toBe(10);
  });

  it("holds for the shortest time on offer that is not shorter than one candle", () => {
    // Every timeframe a spec can be written on: 1m, 5m, 15m, 1h, 4h, 1d.
    expect(holdSecondsFor(60)).toBe(60);
    expect(holdSecondsFor(300)).toBe(300);
    expect(holdSecondsFor(900)).toBe(900);
    expect(holdSecondsFor(3600)).toBe(3600);
    // A candle between two holds takes the longer one, never the shorter.
    expect(holdSecondsFor(120)).toBe(300);
    expect(holdSecondsFor(1800)).toBe(3600);
  });

  it("holds for the longest time on offer when a candle is longer than that", () => {
    expect(holdSecondsFor(14_400)).toBe(3600);
    expect(holdSecondsFor(86_400)).toBe(3600);
  });

  it("only ever answers a hold that is on offer", () => {
    for (const candle of [1, 59, 60, 61, 299, 900, 901, 3601, 604_800]) {
      expect(AUTOPILOT_DURATIONS).toContain(holdSecondsFor(candle));
    }
  });

  it("calls a long up and a short down", () => {
    expect(directionOf("long")).toBe("up");
    expect(directionOf("short")).toBe("down");
  });

  it("knows one market by the names the spec and the venue give it", () => {
    expect(sameMarket("BTC/USD", "BTC/USD")).toBe(true);
    expect(sameMarket("btc / usd", "BTC/USD")).toBe(true);
    expect(sameMarket("BTC", "BTC/USD")).toBe(true);
    expect(sameMarket("ETH/USD", "BTC/USD")).toBe(false);
    expect(sameMarket("BTC/EUR", "BTC/USD")).toBe(false);
    expect(sameMarket("", "")).toBe(false);
  });
});

describe("when a candle is judged", () => {
  it("names the newest candle that has closed, never the one still forming", () => {
    // 12:07:30 on a 15m candle: 11:45 has closed, 12:00 is forming.
    const noon = 1_791_633_600;
    expect(noon % 900).toBe(0);
    expect(lastClosedBucket(noon + 450, 900)).toBe(noon - 900);
    // On the boundary the candle that just ended is the one that has closed.
    expect(lastClosedBucket(noon, 900)).toBe(noon - 900);
    expect(lastClosedBucket(noon - 1, 900)).toBe(noon - 1800);
    expect(lastClosedBucket(noon + 59, 60)).toBe(noon - 60);
    expect(lastClosedBucket(noon + 60, 60)).toBe(noon);
  });

  it("judges nothing on the first sweep after it is turned on: it only notes where it starts", () => {
    expect(sweepStep(undefined, 900)).toBe("arm");
    expect(sweepStep(null, 900)).toBe("arm");
    // Bucket zero is a bucket, not an absence.
    expect(sweepStep(0, 0)).toBe("wait");
  });

  it("judges a candle once: when one has closed since the last it judged, and not again", () => {
    expect(sweepStep(900, 900)).toBe("wait");
    expect(sweepStep(900, 1800)).toBe("judge");
    // Once that write has landed, the same sweep run again waits.
    expect(sweepStep(1800, 1800)).toBe("wait");
    // A spec moved to a longer candle: its newest closed candle began before the one remembered.
    expect(sweepStep(1800, 0)).toBe("wait");
  });

  it("walks a strategy through a morning without judging any candle twice", () => {
    const start = 1_791_633_600;
    let judged: number | undefined;
    const steps: string[] = [];
    // A sweep a minute for 32 minutes on a 15m candle.
    for (let minute = 0; minute <= 32; minute++) {
      const closed = lastClosedBucket(start + minute * 60 + 5, 900);
      const step = sweepStep(judged, closed);
      if (step !== "wait") {
        steps.push(`${minute}:${step}`);
        judged = closed;
      }
    }
    expect(steps).toEqual(["0:arm", "15:judge", "30:judge"]);
  });

  it("reads the candle length off a stored spec, and nothing off one that does not parse", () => {
    expect(candleSecondsOf(RULE_04)).toBe(900);
    expect(candleSecondsOf({ ...RULE_04, series: { ...RULE_04.series, bucketSeconds: 3600 } })).toBe(3600);
    // A draft has no enforced spec, and a fragment of one is not one.
    expect(candleSecondsOf(undefined)).toBeNull();
    expect(candleSecondsOf({ series: { bucketSeconds: 900 } })).toBeNull();
  });
});

describe("how long a proposal waits", () => {
  const at = 1_791_650_000_000;

  it("may be begun inside its window, and not after", () => {
    expect(withinHandoff(at, at)).toBe(true);
    expect(withinHandoff(at, at + HANDOFF_WINDOW_MS - 1)).toBe(true);
    expect(withinHandoff(at, at + HANDOFF_WINDOW_MS)).toBe(false);
    // A clock that reads before the proposal was written is not trusted to open it.
    expect(withinHandoff(at, at - 1)).toBe(false);
  });

  it("is finished only once no order begun in the window could still be on its way", () => {
    expect(HANDOFF_EXPIRY_MS).toBeGreaterThan(HANDOFF_WINDOW_MS + ORDER_LOCK_MS);
    expect(handoffExpired(at, at + HANDOFF_WINDOW_MS)).toBe(false);
    expect(handoffExpired(at, at + HANDOFF_EXPIRY_MS - 1)).toBe(false);
    expect(handoffExpired(at, at + HANDOFF_EXPIRY_MS)).toBe(true);
  });
});

describe("what a proposal's row becomes", () => {
  it("reads as executed once a timed trade has opened for it, and never as a live fill of the rule's own size", () => {
    expect(openedPatch("k27timed", 1_791_650_000_000)).toEqual({
      handoff: "opened",
      status: "executed",
      executedAt: 1_791_650_000_000,
      executionMode: "paper",
      timedTradeId: "k27timed",
    });
  });

  it("reads as undone, with the reason, when nothing was opened", () => {
    expect(notOpenedPatch("BTC is in a timed trade on the shared account.")).toEqual({
      handoff: "not_opened",
      status: "undone",
      handoffReason: "BTC is in a timed trade on the shared account.",
    });
  });
});

describe("BeginBody", () => {
  const open = { proposalId: "k57abc", network: "testnet", asset: "BTC/USD", action: "open", side: "long", notionalUsd: 50, leverage: 5 };

  it("reads a proposal's opening order, and the closing order that takes a position back", () => {
    expect(BeginBody.parse(open)).toEqual(open);
    const close = { proposalId: "k57abc", network: "testnet", asset: "BTC/USD", action: "close" };
    expect(BeginBody.parse(close)).toEqual(close);
  });

  it("names a proposal and nobody else", () => {
    expect(BeginBody.safeParse({ ...open, userId: "abc" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...open, subject: "did:privy:someone" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...open, strategyId: "k9" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...open, proposalId: "" }).success).toBe(false);
    const { proposalId: _none, ...nameless } = open;
    expect(BeginBody.safeParse(nameless).success).toBe(false);
  });

  it("turns away a float where an integer belongs, and an action it does not know", () => {
    expect(BeginBody.safeParse({ ...open, notionalUsd: 12.5 }).success).toBe(false);
    expect(BeginBody.safeParse({ ...open, leverage: 2.5 }).success).toBe(false);
    expect(BeginBody.safeParse({ ...open, action: "flip" }).success).toBe(false);
    expect(BeginBody.safeParse({ ...open, side: "sideways" }).success).toBe(false);
  });
});

describe("StartBody", () => {
  const start = {
    proposalId: "k57abc",
    network: "testnet",
    asset: "BTC/USD",
    direction: "up",
    stakeUsd: 10,
    leverage: 5,
    seconds: 900,
    openedAt: 1_791_650_000_000,
    expiresAt: 1_791_650_900_000,
    size: { atoms: "60", decimals: 5 },
    entryPrice: { atoms: "828471", decimals: 1 },
  };

  it("reads a trade that has opened for a proposal, with or without its fee and transaction", () => {
    expect(StartBody.parse(start)).toEqual(start);
    const full = { ...start, openFee: { atoms: "8575", decimals: 6 }, openTx: "0x" + "ab".repeat(32) };
    expect(StartBody.parse(full)).toEqual(full);
  });

  it("has to name its proposal, and takes no field that names a user", () => {
    const { proposalId: _none, ...nameless } = start;
    expect(StartBody.safeParse(nameless).success).toBe(false);
    expect(StartBody.safeParse({ ...start, userId: "abc" }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, origin: "autopilot" }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, status: "closed" }).success).toBe(false);
  });

  it("is held to what a person's timed trade is held to", () => {
    expect(StartBody.safeParse({ ...start, stakeUsd: 12.5 }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, size: { atoms: "0.0006", decimals: 5 } }).success).toBe(false);
    expect(StartBody.safeParse({ ...start, direction: "sideways" }).success).toBe(false);
  });
});

describe("ReportBody", () => {
  it("says a proposal was opened, and by which timed trade", () => {
    const opened = { proposalId: "k57abc", outcome: "opened", timedTradeId: "k27timed" };
    expect(ReportBody.parse(opened)).toEqual(opened);
    expect(ReportBody.safeParse({ proposalId: "k57abc", outcome: "opened" }).success).toBe(false);
  });

  it("says a proposal was not opened, and why", () => {
    const not = { proposalId: "k57abc", outcome: "not_opened", reason: "The BTC market is closed." };
    expect(ReportBody.parse(not)).toEqual(not);
    expect(ReportBody.safeParse({ proposalId: "k57abc", outcome: "not_opened" }).success).toBe(false);
    expect(ReportBody.safeParse({ ...not, reason: "" }).success).toBe(false);
  });

  it("cannot say both, say anything else, or name a user", () => {
    expect(ReportBody.safeParse({ proposalId: "k57abc", outcome: "opened", timedTradeId: "k27timed", reason: "x" }).success).toBe(false);
    expect(ReportBody.safeParse({ proposalId: "k57abc", outcome: "retry", reason: "x" }).success).toBe(false);
    expect(ReportBody.safeParse({ proposalId: "k57abc", outcome: "not_opened", reason: "x", userId: "abc" }).success).toBe(false);
  });
});
