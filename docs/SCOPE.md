# Kanon — Scope

Six weeks. Submission 13 October 2026. Judging 14–27 October.

Submitted work must be built during the window and verifiable as such. Fresh
repo, clean commit history, dated tags.

## In scope

- One asset, one timeframe. BTC/USD, 15m.
- Three predicates: break of structure, fair value gap, liquidity sweep.
- Canonical price series contract with bucketing.
- Strategy spec schema, compiler, review, pinning with bond.
- Refusal path with named predicate and failing number.
- Trade proposal with satisfied predicates and undo window.
- Evidence chain, one tap from any trade.
- Blocked trades log with would-have-lost count.
- Cooling-off on loosening.
- Shareable strategy card.

## Out of scope

- A strategy marketplace
- Multiple assets or timeframes
- Backtesting
- Copy trading or subscriptions to another user's strategy
- Portfolio management
- Social features, leaderboards, comments
- Alerts and push notifications
- The challenge/falsification mechanism, unless weeks 1–4 finish early
- Anything requiring App Store review

The strategy card is designed to be shared. Sharing is not a feature to build.

## Order of work

**Week 1.** Canonical series contract. Pyth integration on Monad mainnet.
Bucketing that handles sparse, event-driven updates. Tests first. Nothing in the
UI yet.

**Week 2.** The three predicates as arithmetic over the series. Spec schema. Spec
encoder. This is the product; if it slips, everything slips.

**Week 3.** Compiler. Natural language to spec, schema-validated, with snapshot
tests against a fixture set. Spec review UI.

**Week 4.** Pinning, refusal path, proposal path, evidence chain. **Feature
freeze at the end of this week.**

**Week 5.** Blocked log, cooling-off, strategy card. Execution integration.
Bounty integrations in priority order, dropping any that resists.

**Week 6.** Polish, demo video, write-up, security section. No new features.

## Bounty claims

Track: Onchain Finance & Trading ($30,000).

| Bounty | Value | Requires |
|---|---|---|
| Agora — mobile trading app | $10,000 | Mobile execution, AUSD margin |
| Perpl — best use of API | $5,000 | Perps execution through Perpl |
| Kuru — consumer trading app | $5,000 | Spot execution through Kuru |
| Nansen | $5,000 | Flow data in the analytics view |
| Privy or Dynamic | $5,000 | Embedded wallet, mobile |
| Perpl — analytics / risk tool | $3,000 | Adherence and risk metrics |
| Mera — one passkey, many keys | $2,500 | Passkey-derived session keys |
| Mera — best UX | $2,500 | Passkey onboarding |
| Envio | $1,000 | HyperIndex for trade history |
| Qwen / Kimi / Hunyuan | credits | Compiler |

Perpl's analytics bounty is under-contested and maps directly onto work the
product needs anyway. Claim it.

## Kill criteria

- Canonical series not producing reliable buckets by end of week 1 → drop to a
  simpler fixed-interval sampling model and say so in the write-up.
- Compiler not schema-stable by end of week 3 → ship a guided spec builder
  instead of free-text, keep everything else. The enforcement is the product, not
  the chat.
- Execution integration blocking by end of week 5 → demo on paper trades against
  live prices, and be explicit about it. The refusal path is what matters.
- Anything not working by end of week 5 → it does not ship.

## What the submission needs

A working phone demo. The three moments: a strategy compiling live from plain
language, a valid setup executing with its evidence, and a refusal — full-bleed,
naming the predicate and the number that failed.

A security section stating plainly why a second AI is not the verifier, and why
the contract never calls a model. That argument is the differentiator, and most
of the room will get it wrong.

Open-source the predicates and the series contract.
