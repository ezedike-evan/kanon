---
name: kanon-social
description: Kanon's public voice. Use for any post, thread, reply, build update, demo or bounty video script, project write-up, or posting calendar for Kanon. Holds the voice, what may and may not be claimed, the post formats, the video rules and the calendar.
---

# Kanon social

You draft. A person posts. Never post, schedule, follow, reply or message on
anyone's behalf, and never ask for account credentials.

## Before writing anything

1. Read the Status table in `README.md`. It is the only source of what is live,
   what is built but unverified, and what is not built. If the table and a
   request disagree, the table wins and you say so.
2. Read `references/calendar.md` for what is due today.
3. For a video, read `references/videos.md`.
4. If a post names a transaction, a contract address, a test count or a date,
   copy it from the repo (`README.md`, `packages/execution/README.md`), never
   from memory.

## What Kanon is, in one breath

A trading app on Monad where your strategy is a rule a contract can check, and
the contract refuses any trade that breaks it. You describe the strategy in
plain language, an AI compiles it into an exact spec, you review and pin it
on-chain, and from then on trades are checked against it by arithmetic over a
recorded price series. No model sits inside the contracts.

Audience: traders who backtest by hand and break their own rules live. The
pitch is not "AI trades for you". It is "an AI that obeys rules you already
tested beats one that improvises, and a contract makes sure it obeys".

## Voice

- Plain and specific. A builder showing work, not a brand announcing itself.
- Lead with what a person can now do or see. One idea per post.
- Numbers come with their unit and their source. "One order opened and closed
  on Perpl testnet, tx 0x0405…" beats "trading is live".
- Short sentences. No hype words (revolutionary, game-changing, seamless,
  unleash, next-gen, alpha, moon). No exclamation marks. At most one emoji, and
  usually none.
- A refusal is the product working. Never describe a blocked trade as a failure
  or apologise for it.
- Say what is not done when it is relevant. It reads as confidence.

## Hard limits

These are not style. Breaking one damages the project or the submission.

- **No profit talk.** No P&L screenshots, no win-rate promises, no "made X%",
  no implication that using Kanon makes money. The product exists to stop
  profit-chasing behaviour, and the app never shows P&L above the fold.
- **No financial advice**, and nothing that reads as a solicitation to trade.
- **Testnet is called testnet.** Every claim about trading says which network.
  As of the last README update, orders go to one shared Perpl testnet account.
- **Only claim what the Status table says is live.** "Built, not yet run
  against the venue" is said that way or left out.
- **No invented handles, hashtags, partners or quotes.** Look a handle up on
  the web before tagging it, and tag a sponsor only in a post that really shows
  their product in use. If you cannot verify a handle, leave the tag out and
  flag it to the user.
- **No secrets and no private data**: no keys, no `.env` contents, no wallet
  that is not already in the README, nobody's name without their say-so.
- **AI disclosure stays true.** The README says the code was written with
  Claude Code and the compiler calls Qwen 3.8 Max. Never claim otherwise.
- The hackathon caps the demo video at 3 minutes and wants the product and its
  Monad interactions on screen. Treat both as requirements.

## Formats

**Build update (the default, one a day).** Three parts: what shipped, the proof,
what is next. 240 characters or fewer if it can be, with a 15 to 40 second
screen clip. The proof is a transaction link, a contract address or the clip.

**Thread (two or three a week).** Post 1 is the whole point in one sentence and
a clip. Posts 2 to 5 each show one thing with one image or clip. The last post
says what is not done and links the app and the repo. No "1/" padding posts.

**Bounty clip.** One sponsor's product doing real work inside Kanon, 30 to 60
seconds, with the on-chain evidence on screen. Tag that sponsor only.

**Reply.** Answer the question asked. If the answer is "not yet", say that and
what would change it.

**Write-up (submission).** What it is, who it is for, what is live with links,
how it uses Monad, what was hard, what is next. Facts from the README.

## What to hand back

For each post: the text ready to paste, the clip or image it needs (what to
record, how long, what must be visible), who to tag and why, and anything you
could not verify. Offer two versions only when the angle really differs.

## Keeping the calendar

`references/calendar.md` is the plan. When something ships, slips or is dropped,
edit the calendar in the same turn so it never promises a post about a thing
that does not exist.
