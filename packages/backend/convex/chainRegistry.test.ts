import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";
import {
  REGISTRY_TOPICS,
  padAddress,
  padUint,
  verifyLooseningFinalizedReceipt,
  verifyLooseningProposedReceipt,
  verifyPinReceipt,
  verifyTightenReceipt,
  type RegistryClaim,
  type RpcLog,
  type RpcReceipt,
} from "./chainLogic";

/**
 * What a receipt has to carry before a rule's row may say what the registry
 * did. The events are built here word by word, as the registry ABI-encodes
 * them, so a change to an event's shape in the contract fails the topic check
 * below before it can pass a row that does not match the chain.
 */

const REGISTRY = "0x00000000000000000000000000000000000000aa";
const ELSEWHERE = "0x00000000000000000000000000000000000000bb";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const SERIES = "0x3333333333333333333333333333333333333333";
const HASH = "0x" + "a1".repeat(32);
const OLD_HASH = "0x" + "b2".repeat(32);
const COMMITMENT = "0x" + "c3".repeat(32);
const BOND = 10_000_000_000_000_000n;

const words = (...parts: string[]) => "0x" + parts.map((p) => p.slice(2)).join("");

const pinned = (o: { address?: string; id?: bigint; owner?: string; specHash?: string; bond?: bigint; commitment?: string; series?: string } = {}): RpcLog => ({
  address: o.address ?? REGISTRY,
  topics: [REGISTRY_TOPICS.pinned, padUint(o.id ?? 7n), padAddress(o.owner ?? WALLET)],
  data: words(o.specHash ?? HASH, padUint(o.bond ?? BOND), o.commitment ?? COMMITMENT, padAddress(o.series ?? SERIES)),
});
const tightened = (o: { id?: bigint; specHash?: string; commitment?: string; series?: string } = {}): RpcLog => ({
  address: REGISTRY,
  topics: [REGISTRY_TOPICS.tightened, padUint(o.id ?? 7n)],
  data: words(OLD_HASH, o.specHash ?? HASH, o.commitment ?? COMMITMENT, padAddress(o.series ?? SERIES)),
});
const proposed = (o: { id?: bigint; specHash?: string; endsAt?: bigint } = {}): RpcLog => ({
  address: REGISTRY,
  topics: [REGISTRY_TOPICS.looseningProposed, padUint(o.id ?? 7n)],
  data: words(o.specHash ?? HASH, COMMITMENT, padAddress(SERIES), padUint(o.endsAt ?? 1_800_086_400n)),
});
const finalized = (o: { id?: bigint; specHash?: string } = {}): RpcLog => ({
  address: REGISTRY,
  topics: [REGISTRY_TOPICS.looseningFinalized, padUint(o.id ?? 7n)],
  data: words(OLD_HASH, o.specHash ?? HASH, COMMITMENT, padAddress(SERIES)),
});

const receipt = (logs: RpcLog[], over: Partial<RpcReceipt> = {}): RpcReceipt => ({
  status: "0x1",
  to: REGISTRY,
  from: WALLET,
  logs,
  ...over,
});
const claim = (r: RpcReceipt | null, over: Partial<RegistryClaim> = {}): RegistryClaim => ({
  receipt: r,
  registryAddress: REGISTRY,
  chainStrategyId: "7",
  specHash: HASH,
  predicatesCommitment: COMMITMENT,
  series: SERIES,
  ...over,
});
const pin = (r: RpcReceipt | null, over: Partial<RegistryClaim> = {}, wallet = WALLET) =>
  verifyPinReceipt({ ...claim(r, over), wallet });

it("the topics are the registry's own event signatures", () => {
  expect(REGISTRY_TOPICS.pinned).toBe(toEventSelector("StrategyPinned(uint256,address,bytes32,uint256,bytes32,address)"));
  expect(REGISTRY_TOPICS.tightened).toBe(toEventSelector("Tightened(uint256,bytes32,bytes32,bytes32,address)"));
  expect(REGISTRY_TOPICS.looseningProposed).toBe(toEventSelector("LooseningProposed(uint256,bytes32,bytes32,address,uint256)"));
  expect(REGISTRY_TOPICS.looseningFinalized).toBe(toEventSelector("LooseningFinalized(uint256,bytes32,bytes32,bytes32,address)"));
});

describe("verifyPinReceipt", () => {
  it("accepts the registry's own pin of this strategy from the linked wallet, and reads the bond off it", () => {
    expect(pin(receipt([pinned()]))).toEqual({ ok: true, bondWei: BOND });
  });

  it("is indifferent to the case of what it compares, and to what the transaction was sent to", () => {
    const upper = (s: string) => "0x" + s.slice(2).toUpperCase();
    const v = pin(receipt([pinned()], { to: ELSEWHERE }), { specHash: upper(HASH), predicatesCommitment: upper(COMMITMENT) }, upper(WALLET));
    expect(v).toEqual({ ok: true, bondWei: BOND });
  });

  it("a transaction that is not mined proves nothing", () => {
    expect(pin(null)).toEqual({ ok: false, reason: "The transaction is not confirmed yet." });
  });

  it("a transaction that reverted proves nothing, whatever logs it is said to carry", () => {
    expect(pin(receipt([pinned()], { status: "0x0" }))).toMatchObject({ ok: false, reason: "The transaction did not succeed." });
  });

  it("a successful transaction with no pin in it proves nothing", () => {
    expect(pin(receipt([]))).toMatchObject({ ok: false });
    expect(pin(receipt([tightened()]))).toMatchObject({ ok: false });
    expect(pin({ status: "0x1" })).toMatchObject({ ok: false });
  });

  it("a look-alike event from any other contract is not the registry's word", () => {
    expect(pin(receipt([pinned({ address: ELSEWHERE })]))).toMatchObject({ ok: false });
  });

  it("somebody else's pin is not this caller's", () => {
    expect(pin(receipt([pinned({ owner: OTHER })]))).toMatchObject({
      ok: false,
      reason: "No pin of this rule from your linked wallet was found in that transaction.",
    });
  });

  it("a pin of another strategy id is not this one", () => {
    expect(pin(receipt([pinned({ id: 8n })]))).toMatchObject({ ok: false });
    expect(pin(receipt([pinned()]), { chainStrategyId: "not a number" })).toMatchObject({ ok: false, reason: "The rule has no registry id." });
  });

  it("a real pin of a different spec, commitment or series does not pin this draft", () => {
    expect(pin(receipt([pinned({ specHash: OLD_HASH })]))).toMatchObject({ ok: false, reason: expect.stringContaining("spec hash") });
    expect(pin(receipt([pinned({ commitment: OLD_HASH })]))).toMatchObject({ ok: false, reason: expect.stringContaining("commitment") });
    expect(pin(receipt([pinned({ series: OTHER })]))).toMatchObject({ ok: false, reason: expect.stringContaining("series") });
  });

  it("two pins of the one id, or a log of the wrong length, is refused, not guessed at", () => {
    expect(pin(receipt([pinned(), pinned()]))).toMatchObject({ ok: false });
    const short = pinned();
    expect(pin(receipt([{ ...short, data: short.data!.slice(0, -64) }]))).toMatchObject({ ok: false, reason: "The registry's log is malformed." });
    expect(pin(receipt([{ ...short, data: undefined as unknown as string }]))).toMatchObject({ ok: false });
  });
});

describe("verifyTightenReceipt", () => {
  it("accepts the registry's own tightening to the hash being recorded", () => {
    expect(verifyTightenReceipt(claim(receipt([tightened()])))).toEqual({ ok: true });
  });

  it("refuses a tightening to another hash, of another strategy, or none at all", () => {
    expect(verifyTightenReceipt(claim(receipt([tightened({ specHash: OLD_HASH })])))).toMatchObject({ ok: false });
    expect(verifyTightenReceipt(claim(receipt([tightened({ id: 8n })])))).toMatchObject({ ok: false });
    expect(verifyTightenReceipt(claim(receipt([proposed()])))).toMatchObject({ ok: false });
    expect(verifyTightenReceipt(claim(null))).toMatchObject({ ok: false, reason: "The transaction is not confirmed yet." });
  });
});

describe("verifyLooseningProposedReceipt", () => {
  it("accepts the registry's own proposal and reads its cooldown end, in milliseconds", () => {
    expect(verifyLooseningProposedReceipt(claim(receipt([proposed()])))).toEqual({ ok: true, cooldownEndsAtMs: 1_800_086_400_000 });
  });

  it("refuses a proposal of another hash, a tightening, and a cooldown no clock can hold", () => {
    expect(verifyLooseningProposedReceipt(claim(receipt([proposed({ specHash: OLD_HASH })])))).toMatchObject({ ok: false });
    expect(verifyLooseningProposedReceipt(claim(receipt([tightened()])))).toMatchObject({ ok: false });
    expect(verifyLooseningProposedReceipt(claim(receipt([proposed({ endsAt: 2n ** 200n })])))).toMatchObject({
      ok: false,
      reason: "The registry's log is malformed.",
    });
  });
});

describe("verifyLooseningFinalizedReceipt", () => {
  it("accepts the registry adopting exactly the pending hash", () => {
    expect(verifyLooseningFinalizedReceipt(claim(receipt([finalized()])))).toEqual({ ok: true });
  });

  it("refuses one that adopted a different hash, and a proposal that has not been applied", () => {
    expect(verifyLooseningFinalizedReceipt(claim(receipt([finalized({ specHash: OLD_HASH })])))).toMatchObject({ ok: false });
    expect(verifyLooseningFinalizedReceipt(claim(receipt([proposed()])))).toMatchObject({ ok: false });
  });
});
