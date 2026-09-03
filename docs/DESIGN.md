# Kanon — Design

Reference exports live in `design/`, one PNG per screen, named to match the
route. Implement to match them.

## Feel

A rule you cannot argue with. Dark, dense, unsentimental. Terminal-adjacent
without cosplaying Bloomberg. Tight corners, not friendly rounded ones.

The failure mode to avoid: generic fintech softness. If a screen starts looking
approachable, it is wrong.

## Colour tokens

Put these in `tailwind.config.js` under `theme.extend.colors`. Reference by name
only.

| Token | Hex | Use |
|---|---|---|
| `void` | `#0B0D10` | App background |
| `panel` | `#14181D` | Cards, chart ground |
| `raised` | `#1D232A` | Sheets, inputs, elevated surfaces |
| `hairline` | `#2A323B` | Borders, gridlines |
| `bone` | `#E6EAEE` | Primary text, prices |
| `ash` | `#8A949E` | Labels, axes, metadata |
| `signal` | `#D4A017` | Brand, pinned rules, the covenant itself |
| `long` | `#1FA97A` | Bids, longs, satisfied predicates |
| `short` | `#D9524A` | Asks, shorts, failed predicates |
| `refused` | `#E8462E` | The block screen |
| `verified` | `#3D8BFD` | Attestation links, proof chips |

`signal` is the key decision. Green and red are spent on market direction, so the
brand needs a third colour meaning *rule*. Amber carries a warning register that
suits a product whose main job is to stop you.

`refused` is deliberately hotter than `short` so a block never reads as just
another losing trade.

Red and green are load-bearing only for direction, never decoration, and always
paired with a glyph or label.

## Type

- Everything numeric is monospaced and tabular. Prices, sizes, percentages,
  timestamps, hashes. No exceptions, and consistent across every screen.
- Type scale: 32 / 24 / 18 / 15 / 13 / 11.
- Labels 11, `ash`, uppercase with slight tracking.
- Predicates render in SMC language verbatim.

## Motion

- Refusal: fast, hard, no bounce. It should feel like a door closing.
- Spec diff: changed parameters fade up in `signal`, hold, settle.
- Cooling-off countdown: continuous, never stepped, never pausable.
- Haptics: distinct heavy pattern on refusal. It should be felt before it is
  read.

## Patterns

**Rule card is the home screen.** The chart is secondary, reached by tapping the
rule. Design will keep trying to give you a hero candlestick chart. Refuse it.

**Refusal is full-bleed.** Not a toast, not an inline error. It names the
predicate that failed and shows the number that failed it.

**Evidence in one tap, always.** Trade → predicates → timestamps → attestations.

**Spec review in two registers.** Plain English by default, parametric one toggle
away. Every inferred default flagged.

**Cooling-off rendered as a real countdown.** Make the friction beautiful rather
than hiding it.

## Screens

| Route | Export | Notes |
|---|---|---|
| `app/(tabs)/index` | `rule-card.png` | Home. Rule, adherence, small price line |
| `app/compile` | `compiler.png` | Chat above, live spec diff below |
| `app/compile/review` | `spec-review.png` | Plain/parametric toggle, editable |
| `app/compile/pin` | `pinning.png` | Ceremony. Hash, bond, biometric |
| `app/trades/proposal` | `proposal.png` | Satisfied predicates, undo countdown |
| `app/trades/[id]` | `trade-detail.png` | Evidence chain, verify link |
| `app/blocked` | `blocked-log.png` | Refusals, and how many would have lost |
| `app/rules/[id]/loosen` | `cooling-off.png` | Unskippable countdown, diff |
| `app/share/[id]` | `strategy-card.png` | Shareable, must work at thumbnail size |
| `app/onboarding` | `onboarding-*.png` | Three screens, ends in a text field |

## Consistency check

Before calling any screen done, compare its number treatment against
`rule-card`, `proposal`, `trade-detail` and `blocked-log`. If the figures drift
in size, weight or alignment, the app stops reading as a single instrument.

## Test conditions

Mid-range Android, throttled connection. Skia charts must hold frame rate on
that device, not on a simulator.
