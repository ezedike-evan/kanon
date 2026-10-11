# Posting calendar

Written 11 October 2026. Submission closes Tuesday 13 October, 11:59 PM ET
(03:59 UTC on the 14th). Judging runs 14 to 27 October. Winners are named on
3 November.

Times are US Eastern, where most of the judges and the Monad audience are.
Add 4 hours for UTC.

A row is posted only if its "needs" column is true on the day. If it is not,
post the fallback or skip the slot. Never post a row about a thing that is not
live. Edit this file when a row ships, slips or is dropped.

## Before the first post

- [ ] Name confirmed (Kanon, unless the review changes it)
- [ ] Handle registered on X, and the same handle held on any other network used
- [ ] Profile: one-line description from `SKILL.md`, the app link, the repo link
- [ ] Hackathon project profile created (edits are reported to be allowed until the deadline)
- [ ] Handles of Monad and of each sponsor to be tagged looked up and written here

Verified handles (fill in, with the date checked):

| Who | Handle | Checked |
|---|---|---|
| Monad | | |
| Perpl | | |
| Privy | | |

## Sprint: 11 to 13 October

| Day | Time (ET) | Kind | Subject | Needs | Asset | Fallback |
|---|---|---|---|---|---|---|
| Sun 11 | 6:00 PM | Intro post | What Kanon is, in the one-breath version, and that it is being built in the open for Metropolis | A public address, even a preview | 20 s clip: a strategy typed, the spec forming | Text and one screenshot, no link |
| Mon 12 | 9:30 AM | Build update | A market order placed from the chart on Perpl testnet, opened and closed | Gateway hosted, order path working on the public address | 30 s clip ending on the transaction in the explorer | The two testnet transactions already in `packages/execution/README.md`, as text |
| Mon 12 | 1:00 PM | Bounty clip | Predict: a pair called up or down for a minute, closed by the server | Predict working on the public address | 30 s vertical clip of the reel, one trade start to finish | Skip |
| Mon 12 | 6:00 PM | Thread | One record of every trade: chart, Predict and rule, each with its transactions | Trading records checked signed in | 3 images: the list, a trade's details, a transaction | Fold into Tuesday's thread |
| Tue 13 | 9:30 AM | Build update | The compiler: plain language to an exact spec, every default shown | Compile and review working on the public address | 30 s clip | Skip |
| Tue 13 | 2:00 PM | Thread | The demo video, and what each part proves | Demo video recorded (see `videos.md`) | The video, then 3 stills | Post the video alone |
| Tue 13 | 9:00 PM | Post | Submitted: the app, the repo, the video, and what is not done yet | Submission sent | Screenshot of the project profile | None: this one is posted |

Submission day order of work: record the demo by 2:00 PM, send the submission
by 8:00 PM, keep the last four hours for a failed upload or a broken link.

## Judging: 14 to 27 October

Three posts a week: Monday, Wednesday, Friday, about 10:00 AM ET. One subject
each, from this list, in whichever order matches what shipped that week.

- Why a refusal is the feature, with a real refusal: the predicate and the number that failed
- How the contract keeps its own price tape, and why that is affordable on Monad
- What it took to place a real order: the venue refused the backend's region, so orders go out from a gateway and the backend only records
- One-minute trades and fees, said straight: a market in and out costs about 0.069%, more than most one-minute moves
- No hidden parameters: every default the compiler chose, on screen and editable
- Tightening is immediate, loosening waits: the cooling-off period, with no override
- Anything that went live that week, as a build update

Reply to every real question within a day. Do not argue with a judge.

## 3 November

One post, whatever the result: what was built, a thank-you to whoever helped,
what happens to the project next. No complaint and no victory lap.

## Log

Record what was actually posted: date, link, and anything learned.

| Date | Link | Note |
|---|---|---|
