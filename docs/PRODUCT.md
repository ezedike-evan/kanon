# Kanon — Product

## One line

Your trading strategy, compiled into a contract that refuses trades breaking your
own rules — including the ones you would have broken yourself.

## The thesis

Every AI trading product asks you to trust the model. Kanon inverts it: the model
proposes, and a contract that cannot think checks the proposal against a rule you
pinned when you were calm.

The user is not protected from the market. They are protected from themselves,
and from their own agent.

## Who it is for

Discretionary traders who already have a strategy and already know they break it.
Specifically Smart Money Concepts traders, who work in rules — break of
structure, fair value gap, liquidity sweep, order block — and then apply them
loosely under pressure. The rules are already rule-shaped. Nobody has made them
binding.

Speak their vocabulary natively. No tooltips explaining what a wick is.
Credibility with this audience is won entirely on language.

## Why the rules can be checked

SMC is unusually amenable to formalisation compared to most discretionary
analysis. A fair value gap is arithmetic on three candles. A liquidity sweep is a
wick beyond a prior extreme with a close back inside. A break of structure is a
comparison against a prior swing point. None of it needs judgment. It needs
parameters, and the compiler's job is to force those parameters into the open.

## The hard problem, stated plainly

An oracle can prove that at time T the price was X. It cannot cheaply prove that
no price exceeded X across a window, because that is a claim about every tick
including the ones nobody published.

Positive claims are cheap to prove. Maximality claims are negative claims, and
negative claims are expensive.

Everything in `docs/ARCHITECTURE.md` is a consequence of that asymmetry. Do not
design around it by having something assert a maximum. Read that document before
touching the oracle layer.

## The four moments

**Compilation.** You describe a strategy in your own words. It becomes a spec you
can read, argue with, and change. You watch your language turn into an object a
dumb machine can check.

**Pinning.** You commit the spec on-chain. This is a ceremony, deliberately
weighted, with a bond posted.

**Refusal.** A setup does not satisfy the spec. The contract blocks it and names
the predicate and the number that failed. This is the hero moment of the entire
product.

**Evidence.** Any trade, taken or blocked, is one tap from the timestamps and
price attestations that decided it. If verification takes more than one tap,
"verifiable" is marketing and traders will treat it as marketing.

## Product rules

**The rule outranks the chart.** Home screen is the strategy, not candles. The
layout must say this before any copy does.

**Adherence is the primary metric.** Trades blocked, and how many would have
lost. That number is the retention driver and the best screenshot the product
has.

**The strategy card is a first-class artifact.** A shareable object with a
provable history and a link anyone can verify. This is the growth loop.

## The narrative

Every trading account on the internet claims an edge and none of them can be
checked. If a strategy is a pinned spec, and every trade it took survived a
falsification window, then the track record is provably that strategy's track
record rather than a screenshot.

Verifiable strategies. Take nobody's word for it, not even your AI's.
