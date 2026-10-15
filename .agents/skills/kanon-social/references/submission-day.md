# Submission day: Tuesday 13 October 2026

Deadline: 11:59 PM US Eastern tonight, which is 03:59 UTC on Wednesday 14
October. The calendar's order of work still stands: demo recorded by 2:00 PM
ET, submission sent by 8:00 PM ET, the last four hours kept for a failed upload.

Written from `README.md` (Status table dated 11 October), the last 15 commits
(newest `a8f7e57`), the screens in `packages/ui`, and the owner's statement of
today's state. The button and label names below are read from the code, not
from a browser session on the live site. If a label differs on screen, trust
the screen.

Contents: 0. Before recording. 1. Demo script, versions A and B. 2. Bounty
clips. 3. Write-up. 4. Posts. 5. Not verified.

## 0. Before recording

### The README is two days behind

The Status table says, as of 11 October, things the owner says are no longer
true. Judges will open the repo. Bring the table up to date before the write-up
is pasted, or use the README-strict lines in section 3.

| README says (11 Oct) | Owner says today (13 Oct) |
|---|---|
| The hosted site "has not yet been opened and used in a browser", has no gateway address, cannot trade, and sign-in needs the Privy app told its address | Sign-in works and a real order went through the hosted gateway this morning |
| Gateway: "Not yet hosted" | Hosted at `https://kanon-gateway.onrender.com`, Frankfurt. Its `/livez` answered `{"ok":true}` when this was written |
| Predict: screen being rebuilt, "No timed trade has yet been opened against Perpl" | Timed trades work on the live site |
| Trading records: "not yet been checked signed in against real orders" | Working |
| Perpl risk: account half "not yet been seen with a real position"; on the hosted site "market data is not connected" | Working at `/risk` |
| Adding to a position: "not yet been run against Perpl" (`packages/execution/README.md`) | Open, add and close work |
| Compiler: "Built in the Convex backend" (no word on the key) | Not working: the model key is not set |

They agree on: pinning from the app has never been run against this
deployment, the app's refusal is decided by the backend, the indexer is not
deployed, Kuru has no screen. The README has no line about Nansen or autopilot.

### Set-up for every take

- Desktop browser, window at least 1280 wide (the Predict side panels and the
  chart's order panel need it), 100% zoom, a clean profile with no bookmarks
  bar and no other tabs. Record 1080p landscape. Captions on every shot.
- Sign in with an account whose name and email may be shown. The Google
  chooser lists every address in the browser; an email code to a project
  address shows the least. A stated cut while the code is fetched is fine.
- The trading account is shared by everyone signed in. Before each take, the
  chart's "Open positions" must read "No open positions on the shared account."
  and Predict's "Running" must be empty. If someone else trades during a take
  (a row reads ENDED ELSEWHERE or CLOSED ELSEWHERE), record again.
- A market holds one position. A chart position on BTC stops Predict on BTC
  ("Holds a position from the chart"). The scripts put Predict on ETH and the
  chart on BTC for that reason.
- One dry run, timed. On 10 October an open took about sixteen seconds; the
  order code has changed since. The shot lengths assume a fill answers in about
  five seconds and its TX link follows a few seconds later. If it is slower,
  hold. Do not speed it up.
- Collapse the left navigation to its icon rail (the chevron at its top) for
  version A. Open, it reads ENFORCEMENT ACTIVE under the wordmark, and in
  version A no rule is pinned.

### Never on camera

- Browser DevTools. Every order request carries your Privy token.
- Profile, "Export wallet key", CONTINUE TO PRIVY. It shows the private key.
- Any `.env`, and the Vercel, Render, Convex or Privy dashboards.
- Home scrolled to its foot (the "Verified P&L · 30d" line).
- The landing page below the hero. Its tiles are illustrations ("0x8f2a...391c
  ATTESTATION VERIFIED", "BLOCK"), and one line reads "See how many blocked
  trades would have lost".
- Any signed-out screen as evidence. Signed out, the app shows sample data
  labelled Demo or SAMPLE.

## 1. The demo video (3:00 cap, aim 2:45)

### Version A: what can be recorded right now

Only the working parts. No compiler, no pin, no refusal, because none of them
runs from the live site today. The caption in A9 says so.

| # | Time | Where | Do | Hold | Caption | Must be visible |
|---|---|---|---|---|---|---|
| A1 | 0:00 to 0:10 | `https://kanon.markets`, signed out, top of the page | Nothing. Do not scroll | 10 s | You tested your rule. Then, live, you broke it. Kanon is a trading app on Monad built so the rule wins. | The address bar. The headline "The rule outranks the chart." |
| A2 | 0:10 to 0:22 | Same page | Click "Launch App" (top right). In the "Welcome" sheet, sign in. You land on `/home` | Until Home has painted | Sign-in is Privy. It makes a wallet for you. What follows is everything that is live today, all of it on testnet. | The "Welcome" sheet, then Home with your account at the foot of the navigation |
| A3 | 0:22 to 0:42 | `/predict` | Click Predict. In the left panel, under "Pairs" click ETH and under "Time" click the one-minute option. On the slide pick the $10 stake. Click UP once | Until the badge reads RUNNING and the "Open" TX link shows under "Entry", then 3 s | A timed trade on Perpl testnet. ETH up, one minute, a $10 stake. The server closes it. I will not touch it again. | The question "Which way does ETH move in the next 1 minute?". The row "Closes itself". The line "One testnet account that everyone signed in shares. Not your funds." The "Time left" countdown. The "Open" TX link |
| A4 | 0:42 to 1:12 | `/chart` | Click Chart. The panel on the right must read "Order · BTC". Pick the $10 size and a leverage. Click LONG. When the result reads FILLED, wait for its "TX 0x..." link and click it. Hold on the explorer, then come back | 5 s on the explorer | A market order from the chart, on Perpl testnet. The fill is a transaction on Monad testnet, settled by Perpl's exchange contract. | In the panel: "Perpl testnet · shared demo account", "Order type: Market, IOC", FILLED. On `testnet.monadscan.com`: the hash, Status Success, To `0x1964...80cc` |
| A5 | 1:12 to 1:32 | `/risk` (Profile, then "Perpl risk") | Scroll slowly from "The account" down to the first two market cards | 6 s on the positions, 6 s on the markets | Every open position on the risk screen: the price it is liquidated at, and how far the mark is from there. Perpl's own figures. A distance, not a result. | The title "Perpl risk" with its Testnet badge. A position row with "Liquidation", the meter, and "entry, mark, margin". A market card with funding, open interest, book width, margin kept. The line "Perpl's public market data, last stamped at ..." |
| A6 | 1:32 to 1:46 | `/chart` | Click CLOSE POSITION in the order panel. Wait for FILLED and its TX link | 3 s | Closed at market. A second transaction. | "Your orders" with both rows, each with a TX link |
| A7 | 1:46 to 2:04 | `/predict` | Click Predict. The trade ended while you were away, so it is in "History" (the panel on the right): click its ETH row, marked TIME UP. In the sheet click the "Close" transaction, hold on the explorer, come back | 3 s History, 6 s sheet, 4 s explorer | The minute ran out while I was on the chart. The server closed the trade. No button was pressed. | The TIME UP badge. "Its time was up, so the server closed it." The rows "Opened", "Closed" and "Ran for". "Open" and "Close", each with a TX link |
| A8 | 2:04 to 2:20 | `/profile/records` | Profile, then "Trading records". Hold on the list. Click the BTC chart trade | 5 s list, 6 s sheet | One record of everything taken, from the chart and from Predict, each with its transactions. | The tiles Total, Chart, Predict, Rule. One Chart row and one Predict row from today. The sheet "TRADE · BTC" with entry, exit and its transaction rows |
| A9 | 2:20 to 2:38 | Two explorer tabs, opened beforehand: StrategyRegistry and RefusalGate (addresses in `README.md`) | Show one, then the other | 6 s each | Kanon's own contracts are deployed on Monad testnet: the registry that pins a rule, and the gate that refuses a trade by arithmetic. 277 Foundry tests pass. The live site has not called them yet. The compiler is built and not switched on. | `0xDB91f547B59A3326f3DB8E8F510E8dbbf4e50852` and `0x388f55962954c5083D885543aF22b1b6EE640ec0` in the address bar |
| A10 | 2:38 to 2:45 | End card, plain text | None | 7 s | Why Monad: a per-minute on-chain price tape is affordable here. kanon.markets. github.com/ezedike-evan/kanon. Testnet. Not audited. | Both addresses, spelled out |

Notes for A:

- A3 must come before A4. The timed trade takes a real minute, and A4 to A6
  fill it. The UP press lands near 0:35, so the trade closes near 1:35 and A7
  finds it closed. If A7 arrives early, the ETH slide still shows the
  countdown: wait on it, and when it ends click DETAILS on the slide instead
  of opening History. Do not press "End now": that would be you closing it,
  not the server.
- The sheets in A7 and A8 state the trade's result ("Result after fees").
  Leave it where the app puts it. Do not zoom on it, caption it or say it.
- A TX link opens the explorer in a new tab. Close that tab to come back, so
  the app's tab is never reloaded mid-take.
- If the take runs long, cut A5 to 10 s (it has its own clip) before touching
  anything else.

**Where Monad is on screen in A, said straight.** Monad testnet transactions
appear five times (A3, A4, A6, A7, A8), and one is opened on the explorer. All
of them are Perpl orders: sent for the shared account through the gateway and
settled by Perpl's exchange contract, `0x1964c32f0be608e7d29302aff5e61268e72080cc`.
None is a call to a Kanon contract and none is signed by the viewer's own
wallet. Kanon's contracts appear once, in A9, as two addresses with no
transaction from the app. If the judges read "Monad interactions" as "your
contracts being used", version A has none.

### Version B: if the compiler key and autopilot land

Each extra shot stands on its own. Add one only after it has worked once, end
to end, on the live site in a dry run today. To make room, drop A5 and cut A9
to 8 s.

| # | Time | Where | Do | Caption | Must be visible | Depends on |
|---|---|---|---|---|---|---|
| B1 | 0:00 to 0:10 | As A1 | As A1 | You tested your rule. Then, live, you broke it. | As A1 | Nothing |
| B2 | 0:10 to 0:18 | As A2 | As A2 | Sign-in is Privy. It makes the wallet that will sign the rule. | As A2 | Nothing |
| B3 | 0:18 to 0:50 | `/create` (AI in the navigation) | Under "Start from one" pick "Go long after a bullish break of structure on the 15m" and send it. Then send "Require a fair value gap of at least 0.15% after the break". Watch the draft panel fill. Click "Review and pin" and scroll the review once | Plain language in, an exact spec out. Every value the compiler chose is marked Default and can be edited. Nothing is pinned until I have read it. | Your words. The draft's "In plain English" and "Parameters". At least one "Default" badge. The review screen | **Compiler key** set on the hosted backend, and one compile seen to finish on the live site |
| B4 | 0:50 to 1:18 | `/compile/pin` | Click "PIN ON-CHAIN". Hold on SPEC HASH, CONTRACT, PREDICATES, SERIES and BOND POSTED. Press "HOLD TO SIGN". Then Profile, "Wallet and signing", "View on Monadscan", and open the newest transaction | Pinned. The spec hash, the predicate list and the price series are in the registry on Monad testnet, signed by my own wallet. Tightening applies at once. Loosening waits. | CONTRACT reading the registry's address. On the explorer: Status Success, To the StrategyRegistry, From your wallet | **B3**, plus the wallet holding testnet MON and the bond, plus **one successful pin from the live site first**. It has never been run there |
| B5 | 1:18 to 1:45 | `/chart`, then the refusal screen | In the order panel click "Check against the rule" | A setup that breaks the rule is refused, with the predicate and the number that failed. Today the app's backend does this arithmetic. The same check is deployed on-chain in the RefusalGate, and calling it from the app is in progress. | "Trade blocked by your own rule." The predicate. The required and actual figures. SHORTFALL | **B4**, and a market that fails the rule at that moment. Do not say the contract refused it unless the gate was called from the app and its transaction is shown. The screen's own link reads "View on-chain evidence": click it only if it leads to a real transaction |
| B6 | 1:45 to 2:15 | Wherever autopilot lists what it opened | Hands off the mouse | Autopilot. The pinned rule is checked on every new candle. This one passed, and a timed trade opened on Perpl testnet. I pressed nothing. | The rule that passed. The new trade with its "Open" TX. The word testnet. The candle's time and the trade's time | **Autopilot** deployed and seen to fire once on the live site. It is uncommitted work in `packages/backend/convex/autopilot.ts` today and no screen for it was found, so this shot has no click list. A pass cannot be scheduled: record a long take and keep the stretch where it fires, with a stated cut. Never trigger it by hand and call it autopilot. If it has not landed, use A3 and A4 here |
| B7 | 2:15 to 2:33 | `/profile/records` | As A8, opening the rule's trade | One record: what the rule took and what it refused, each with its transactions. | As A8, with a "By rule" or "Refused" row | B5 or B6 |
| B8 | 2:33 to 2:45 | End card | As A10 | As A10 | As A10 | Nothing |

Notes for B:

- B5 needs the rule to fail and B6 needs it to pass. Those are different
  candles. Record them as separate takes and join them with a stated cut.
- Autopilot as the uncommitted code reads today (it may change): a sweep runs
  once a minute and judges a rule only when a candle of the rule's own
  timeframe has closed. The first sweep after it is switched on only notes the
  candle and judges nothing. So a 15-minute rule gets one verdict every 15
  minutes, and the first comes after the second candle closes. Allow for that.
- The same code records a failed candle as a refusal like any other. A refusal
  that autopilot made, with no button pressed, is as true a shot as a pass and
  far more likely inside one afternoon. If that is what happens, show it in B5
  and say so.
- The price series keeper does not run continuously, and the gate requires a
  fresh sample. A call that fails because the series is stale is not a
  refusal. Do not show it as one.
- If the compiler is served from a host other than Alibaba Cloud DashScope
  (commit `a8f7e57` added that route), the AI disclosure in section 3 and in
  the README must name the host and model actually called.

**Where Monad is on screen in B.** B4 is the first transaction to a Kanon
contract from the live site, signed by the Privy embedded wallet. That shot is
the answer to "show your Monad interactions". B5 adds one only if the gate is
called from the app. B6 and B7 add Perpl fills, as in A.

## 2. Bounty clips

**Read this before recording any of them.** `videos.md` says not to script a
bounty clip until that bounty's own text has been pasted, because adherence to
the published requirement is reported to weigh most. These three are written
against a secondhand summary from another team, plus the titles on the public
page (`monad.xyz/metropolis`, read 13 October): Perpl "Best use of Perpl's
API", Perpl "Best Analytics / Risk Tool", Privy "Privy!". The requirement
texts are behind the portal login. Open them, and reorder the shots to follow
their sentences, before recording.

### Perpl API, 55 s

Summary of the ask: "a production-ready trading bot or automation system on
Perpl".

| # | Time | Do | Caption | Must be visible |
|---|---|---|---|---|
| 1 | 0:00 to 0:05 | `/predict`, signed in | Perpl's API inside Kanon: a trade the server opens and closes by itself, on Perpl testnet. | The address bar |
| 2 | 0:05 to 0:14 | Left panel: ETH, the one-minute option. On the slide, the $10 stake. Hold on the rows above the stake | What a press means is on screen before it is sent: the size, the time it closes itself, the most it can lose. | "Closes itself", "Most it can lose", the shared testnet account line |
| 3 | 0:14 to 0:24 | Click UP once. When "Open" TX shows under "Entry", click it, hold on the explorer, come back | One press. The server opened a position through Perpl's signed API. This is the fill, on Monad testnet. | RUNNING, the countdown, then Status Success and To `0x1964...80cc` on the explorer |
| 4 | 0:24 to 0:30 | Hands off. Let the countdown run | From here I press nothing. | The countdown and the system clock |
| 5 | cut | One cut, with the words "cut: 35 seconds of countdown" on screen | None | The clock before and after |
| 6 | 0:30 to 0:42 | Stay on the slide as it ends | Time is up. The server sent the closing order. It would have closed sooner if the loss at the mark had reached the stake. | "Its time was up, so the server closed it." |
| 7 | 0:42 to 0:55 | Click DETAILS, then the "Close" transaction | Opened and closed through Perpl's API on testnet, each with its transaction. One shared testnet account. | "Open" and "Close" TX links, then the explorer |

Say it is met by: a timed trade is an automation on Perpl's API. One press
opens a position at market, and the server closes it on a timer, or sooner at
a loss equal to the stake, with both fills on Monad testnet.

Still missing: nothing decides to enter by itself, since a person presses UP
or DOWN and autopilot is not live. It runs on one shared testnet account, on
testnet only, unaudited. The README supports none of the words
"production-ready".

If the portal allows more than a minute, drop the cut and let the countdown
run.

### Perpl analytics and risk, 50 s

Summary of the ask: "a real-time analytics, risk-monitoring or portfolio
intelligence dashboard focused on Perpl".

Before recording, open one position from the chart (BTC, $10) and leave it
open.

| # | Time | Do | Caption | Must be visible |
|---|---|---|---|---|
| 1 | 0:00 to 0:06 | `/chart`: the order panel with the open position and its TX link | A live risk screen for Perpl, inside Kanon. This is a real position on Perpl testnet. | "Open position", "Perpl testnet · shared demo account", the TX link |
| 2 | 0:06 to 0:22 | `/risk`. Hold on "The account" | Each position with the price it is liquidated at and how far the mark is from there. | The Testnet badge. Free, In positions, Exposure, Flagged. The position row: Liquidation, the meter, entry, mark, margin |
| 3 | 0:22 to 0:36 | Scroll through "Markets". Wait for the "last stamped at" time to change once | Every Perpl market, read again every few seconds: funding per event and per year, open interest, book width, mark against oracle, margin kept. | Two market cards. The stamp changing |
| 4 | 0:36 to 0:42 | Scroll back to "Worth a look" | Anything out of line is listed first. | The flagged lines, or "Nothing is flagged." |
| 5 | 0:42 to 0:50 | "How this is worked out", then click "Perpl's formula" | The liquidation price is Perpl's published formula, before funding. Nothing here is estimated. | The card, then Perpl's liquidation page |

Say it is met by: real time, because it reads Perpl's public market data
through the gateway every few seconds. Risk monitoring, because each position
shows its liquidation price and distance, and out-of-line books, marks and
funding come first.

Still missing: the account is one shared testnet account, so it is not a
personal portfolio. There are no alerts and no history. The liquidation price
is stated before funding. The README still says the account half had not been
seen with a real position, so this clip is the first evidence of it.

### Privy, 50 s

Summary of the ask: none was given. The public title is "Privy!". Login alone
is reported not to qualify.

| # | Time | Do | Caption | Must be visible |
|---|---|---|---|---|
| 1 | 0:00 to 0:05 | Landing page, signed out | Privy in Kanon: the sign-in, the wallet, and the check before every order. | The address bar |
| 2 | 0:05 to 0:16 | "Launch App". Sign in from the "Welcome" sheet | Email, Google or a passkey. No extension and no seed phrase. | "Email address", "Continue with Google", "Continue with Passkey" |
| 3 | 0:16 to 0:30 | Profile, "Wallet and signing". Hold. Click "View on Monadscan" | Privy made this wallet at sign-up. It is on Monad testnet, and it is the wallet that signs a pinned rule. | Address. "Privy embedded wallet". "Monad Testnet · chain 10143". "Signed in with". Then the same address on the explorer |
| 4 | 0:30 to 0:40 | `/chart`: one $10 LONG, to FILLED | This order went out with my Privy token. The backend checked it against Privy's keys before the order was recorded or sent. | FILLED and its TX link |
| 5 | 0:40 to 0:50 | Profile, "Sign out", SIGN OUT. Open `/chart` again | Signed out, the same panel sends nothing. It offers sign-in. | "Sign in to trade" where the order line was |

Close the position from shot 4 once the recording has stopped.

Say it is met by: Privy is the only way in, it creates the wallet on Monad
testnet at sign-up, and every order carries the caller's Privy token, which
the backend verifies before anything is sent.

Still missing: the embedded wallet has not signed a transaction from the live
site. Pinning a rule is the one thing it signs, and that has never been run
there. If the bounty wants the wallet used on-chain, this clip does not show
it. Version B's pin (B4) would.

## 3. The write-up

Tagline (88 characters):

```
A trading app on Monad where your strategy is a rule a contract can check. Testnet beta.
```

Write-up (342 words as written; 347 with the README-strict lines below):

```text
WHAT IT IS
Kanon is a trading app on Monad where your strategy is a rule a contract can check. You describe it in plain language, an AI compiles it into an exact spec, you review and pin it on-chain, and trades are checked against it by arithmetic over a price series the contract records itself. A refusal names the predicate and the number that failed.

WHO IT IS FOR
Traders who backtest a rule by hand and then break it live.

WHAT IS LIVE (Monad testnet, nothing audited)
- App: https://kanon.markets
- Code: https://github.com/ezedike-evan/kanon
- Contracts, chain 10143: StrategyRegistry 0xDB91f547B59A3326f3DB8E8F510E8dbbf4e50852, RefusalGate 0x388f55962954c5083D885543aF22b1b6EE640ec0, more in the README. 277 Foundry tests pass.
- Chart orders ($10 to $100, up to 5x) and timed trades the server closes itself, on Perpl testnet, on one shared account.
- One trading record with each trade's transactions, and a Perpl risk screen.
- A real fill: https://testnet.monadscan.com/tx/0xc533b0b04fcf0aa8bbaaea78b810184f8ee609b71248c3082243523d4f3b6cc5

NOT LIVE YET
The compiler is built, not yet switched on. Pinning from the app has not been run on this deployment. The app's refusal is decided by the backend, not yet by the on-chain gate. Rule trades are paper fills.

HOW IT USES MONAD
The series contract samples the price feed on a fixed cadence, so "the swing high" is a maximum anyone can read back. That is a transaction per sample, affordable at Monad's fees and block times. The keeper does not run continuously yet. Every Perpl fill is a Monad testnet transaction.

WHAT WAS HARD
Perpl refuses its trading API (HTTP 451) to the region the backend runs in, so orders leave from a separate gateway and the backend only checks who is asking and records.

WHAT IS NEXT
Calling the gate from the app, a continuous keeper, the Envio indexer, and mainnet on Pyth's real feed.

AI TOOLS
Most of the code was written with Claude Code (Anthropic), directed and reviewed by the author. The compiler calls Qwen 3.8 Max through Alibaba Cloud DashScope; the user reviews its output before pinning. No contract calls a model.
```

What in it does not come from the README:

- The two lines beginning "Chart orders" and "One trading record" describe
  the hosted site as the owner reports it today. The README does not say that
  yet. Update the Status table first, or paste these two instead:

```text
- Chart orders on Perpl testnet, one shared account: opened and closed from the chart on a developer's machine on 10 October.
- Built and tested, not yet checked against real orders: timed trades, the trading record, the risk screen's positions.
```

- "Not switched on at the hosted site" is the owner's word. The README says
  only that the compiler is built. If the key lands and a compile works on the
  live site, move the compiler up into "What is live" and say what was seen.
- "Every Perpl fill is a Monad testnet transaction" was checked on the
  explorer for the linked fill: Status Success, block 69784237, 10 October
  2026, To Perpl's exchange contract.
- If version B's pin is recorded, add its transaction under "What is live"
  and delete the pinning sentence from "Not live yet".

## 4. Posts for today

Handles checked 13 October: Monad is `@monad`, Perpl is `@perpltrade`, Privy
is `@privy_io`. No official Metropolis hashtag was found, so none is used.

### When the demo video goes out (calendar: Tue 13, 2:00 PM ET)

Attach: the demo video itself, uploaded to the post, not linked. The text is
for version A. It is 269 characters as X counts it, 276 with the tags.

```text
Kanon's demo for Monad Metropolis. 2:45, testnet only.

A market order on Perpl testnet from the chart. A timed trade the server closes itself. Every fill with its Monad testnet transaction.

The rule compiler is not in it: built, not yet live.

kanon.markets
```

With tags, same length limit. The video shows Perpl's product in use, so
Perpl may be tagged. Monad is the host:

```text
Kanon's demo for @monad Metropolis. 2:45, testnet only.

A market order on @perpltrade testnet from the chart. A timed trade the server closes itself. Every fill with its Monad testnet transaction.

The rule compiler is not in it: built, not yet live.

kanon.markets
```

If version B is what was recorded, replace the third paragraph with only what
is in the video, for example "A rule typed in plain language, compiled, and
pinned on Monad testnet." Do not mention the refusal as on-chain unless B5
showed the gate's transaction.

### Submitted (calendar: Tue 13, 9:00 PM ET)

Attach: a screenshot of the project profile on the hackathon platform, showing
the project name and the submitted state, with nothing private in the frame.
Post it as a quote of the demo post so the video travels with it. It is 265
characters as X counts it.

```text
Kanon is submitted to Monad Metropolis.

Live on testnet: chart orders and timed trades on Perpl, one trading record, a Perpl risk screen.

Not live from the app yet: the rule compiler, pinning, the on-chain refusal.

kanon.markets
github.com/ezedike-evan/kanon
```

Tag `@monad` after "Metropolis" if wanted. No sponsor tag here: the post shows
no sponsor's product.

## 5. Not verified

- That the live site signs in, trades, closes timed trades, and shows records
  and risk. This is the owner's report. Only `/livez` on the gateway and the
  landing page's title were seen to answer.
- Every button and label name, on the hosted build. They are read from the
  code at `a8f7e57`.
- The three bounty requirement texts. Only their titles are public.
- The 3:00 video cap and the wish for Monad interactions on screen. Both come
  from the skill; the public Metropolis page states neither.
- Autopilot's screen and behaviour. Its backend is uncommitted work in the
  working tree. Whether any of it is deployed could not be told from here.
- On the explorer, read 13 October: the BTC/USD series contract shows one
  transaction in total, from 5 October, and neither it nor the registry shows
  verified source. A9 will show bytecode pages. Verifying the contracts on
  Monadscan before recording would make that shot stronger. The series' single
  transaction is why no shot presents the price tape as running.
