# Videos

Two kinds: the submission demo (one, 3 minutes at most) and bounty clips (one
per sponsor bounty entered, short).

## Rules for every video

- Screen recording of the real app, real data, real network. No mockups, no
  sped-up loading that hides a wait, no cut that hides a failure.
- The network is visible or said: testnet or mainnet.
- Every claim is followed by its evidence on screen: the transaction on the
  explorer, the contract address, the refusal with the number that failed.
- No P&L as a hook. A result may appear where the app shows it (a trade's
  details), never as the headline.
- Voice-over or captions in plain words. Captions always, so it works muted.
- 1080p, landscape for the demo; vertical is fine for a Predict clip, since
  Predict is a vertical reel.
- Record once the feature is deployed, on the public address, not localhost.

## The submission demo (3:00 hard cap)

The hackathon wants the product and its Monad interactions shown. Aim for 2:45.

| Time | Shot | Says |
|---|---|---|
| 0:00 to 0:15 | A trader breaking their own rule, in one sentence over the app's home | The problem: you know your rule and you break it live |
| 0:15 to 0:50 | Type a strategy in plain language, the spec forms, review it | An AI compiles it into an exact spec. Nothing is hidden, every default is editable |
| 0:50 to 1:20 | Pin it. The transaction on the Monad explorer | The rule is now on-chain. Tightening is immediate, loosening waits |
| 1:20 to 1:55 | A setup that breaks the rule is refused, naming the predicate and the number | A refusal is the product working. The contract did arithmetic, no model |
| 1:55 to 2:25 | Trade from the chart on Perpl; a Predict timed trade; both in Trading records with their transactions | Real orders, and one record of everything you took |
| 2:25 to 2:45 | Why Monad, in one line, then the address and the repo | A per-minute on-chain price tape is affordable here |

Cut anything that is not live on the day. A shorter true demo beats a full one
with a faked step.

## Bounty clips

Bounty judging weighs adherence to the sponsor's published requirements most
(reported as 40%). The exact requirement texts are behind the hackathon
dashboard login. **Do not script a bounty clip until the user has pasted that
bounty's text**; then build the shot list from its sentences, one shot per
requirement.

Candidates, with what the README says exists today. Re-read the README before
using any row.

| Bounty | What Kanon has | Missing before a clip |
|---|---|---|
| Perpl API | Market orders from the chart's ticket and timed trades from Predict, sent through Perpl's signed API on testnet | The gateway hosted publicly; the requirement text |
| Perpl analytics or risk tool | One trading record across chart, Predict and rule trades, with entry, exit and transactions | Risk figures per position (margin, liquidation price); the requirement text |
| Privy | Sign-in, an embedded wallet, the server verifying the Privy token before any order | Something beyond login in the core flow, since login-only is reported not to qualify; the requirement text |
| Qwen | The compiler that turns plain language into a spec calls Qwen 3.8 Max | The requirement text |
| Kuru | A spot client, written and unit-tested | Wired into the app and run against Kuru |
| Envio | HyperIndex handlers and schema, written | Deployed, and behind a feature a user sees |
| Agora mobile trading | The same screens run in the Expo app; Perpl's collateral is AUSD | A build someone can install; the requirement text |

One clip per bounty, 30 to 60 seconds: the sponsor's product doing the work,
then the evidence. Name the sponsor in the first five seconds.
