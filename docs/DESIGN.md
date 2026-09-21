# Kanon — Design

Reference exports live in `design/`, one PNG per screen, named to match the
route. Implement to match them.

## Feel

A rule you cannot argue with. Dark, dense, unsentimental. Terminal-adjacent
without cosplaying Bloomberg. Tight corners, not friendly rounded ones.

The failure mode to avoid: generic fintech softness. If a screen starts looking
approachable, it is wrong.

## Colour tokens and themes

Colours are semantic tokens with two values, dark and light. The Tailwind
utilities (`bg-panel`, `text-ash`, `border-hairline`) hold
`rgb(var(--c-name) / <alpha-value>)`, so one class works in both themes and
`bg-void/80` still takes an alpha. Source of truth: `packages/tokens/src/index.ts`
(`colors`, `lightColors`); `pnpm tokens` regenerates `preset.cjs` and
`theme.css`. Reference by name only. No hex in a screen or a component. Where a
class cannot reach (SVG strokes, `placeholderTextColor`, shadows, chart
layouts), read `useTheme().colors[token]`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `void` | `#0B0D10` | `#F2F4F7` | App background |
| `panel` | `#14181D` | `#FFFFFF` | Cards, chart ground |
| `raised` | `#1D232A` | `#E8ECF1` | Sheets, inputs, icon tiles, elevated surfaces |
| `hairline` | `#2A323B` | `#D0D7DF` | Borders, gridlines |
| `bone` | `#E6EAEE` | `#11161C` | Primary text, prices |
| `ash` | `#8A949E` | `#525D69` | Labels, axes, metadata |
| `signal` | `#D4A017` | `#916400` | Brand, pinned rules, the covenant itself |
| `long` | `#1FA97A` | `#0A7551` | Bids, longs, satisfied predicates |
| `short` | `#D9524A` | `#BE332B` | Asks, shorts, failed predicates |
| `refused` | `#E8462E` | `#CC2A10` | The block screen |
| `verified` | `#3D8BFD` | `#1D5FD1` | Attestation links, proof chips |
| `lift` | `#1D232A` | `#FFFFFF` | The selected segment sitting in a `sunken` track |
| `scrim` | `#07090B` | `#0B1118` | Dim behind a sheet, shadow ink (always dark) |

Support tokens (`canvas`, `sunken`, `*-hot`, `*-wash`, `diff-*`, `inferred-*`)
exist in both themes; see the token file.

`signal` is the key decision. Green and red are spent on market direction, so the
brand needs a third colour meaning *rule*. Amber carries a warning register that
suits a product whose main job is to stop you. In the light theme it deepens to
an ochre so it still reads as text and as a fill under light type.

`refused` is deliberately hotter than `short` so a block never reads as just
another losing trade.

Red and green are load-bearing only for direction, never decoration, and always
paired with a glyph or label.

### Theme

Three modes: **Dark** (default), **Light**, **System**. Chosen in Profile >
Appearance, persisted through the `storage` platform capability (localStorage on
the web, expo-secure-store on a device), applied by `ThemeProvider` mounted at
both app roots. `useTheme()` returns `{ mode, setMode, scheme, colors }`. On the
web an inline boot script sets `data-theme` on `<html>` before first paint, so a
light-mode user never sees a dark flash. Every text-bearing token clears 4.5:1
on `panel` and `void` in both themes; a test enforces it
(`packages/ui/src/lib/theme-logic.test.ts`). Semantics do not change between
themes: amber is the rule, long/short are direction, refused is hotter than
short, verified is blue.

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

## Information architecture

Five tabs, bottom-anchored, in this order:

| Tab | Route | What it is |
|---|---|---|
| HOME | `/home` | The rule card and what the rule has done: the pinned rule, adherence, recent activity, small price line |
| CHART | `/chart` | Full-height chart, drawing tools, the rule overlaid on price |
| AI | `/create` | The strategy builder: talk to the model, watch the spec form. The raised centre button |
| PREDICT | `/predict` | Threshold markets |
| PROFILE | `/profile` | Trading records, previous rules, copy trading, vault, security, theme |

This replaces the earlier "rule card is home, refuse a hero chart" position.
The chart is a first-class tab now because a trading app without one is not a
trading app. What still holds: the chart never carries P&L above the fold, and
every claim on it is one tap from evidence.

**The centre tab must explain itself.** A raised `signal` button, sparkles glyph,
label `AI`. One spring on press, no idle animation. Never an unlabeled orb.

**Active tab** changes three things together: a 2px `signal` bar on the tab's top
edge, the icon to `bone` at 2px stroke, the label to `bone`. Inactive is `ash`.
State never rests on colour alone.

**Refusal is full-bleed.** Not a toast, not an inline error. It names the
predicate that failed and shows the number that failed it. It is a success
state and never styled as an error.

**Evidence in one tap, always.** Trade > predicates > timestamps > attestations.

**Spec review in two registers.** Plain English by default, parametric one toggle
away. Every inferred default flagged.

**Cooling-off rendered as a real countdown.** Make the friction beautiful rather
than hiding it.

## Density and rhythm

"Scanty" is the failure: a screen with one number and a lot of dark. Raise
density with hierarchy, not decoration.

- **Spacing scale (px):** 2, 4, 6, 8, 12, 16, 20, 24, 32, 40. Gaps inside a group
  are 4 to 8; between groups 20 to 24; screen gutter 20. Off-scale values need a
  reason (optical fix).
- **Radius:** 2 (`rounded-xs`: chips, badges, segments), 3 (`rounded-sm`: cards,
  buttons, inputs, icon tiles), 4 (`rounded-md`: sheets, the AI button). Nothing
  softer than 4 except a status dot. No pills, no circles for avatars.
- **Elevation:** four steps, `0` flat, `1` hairline lift, `2` raised block, `3`
  sheet. Depth is surface tone plus hairline first; a shadow (`elevationStyle`)
  is added only for 2 and 3, tinted with the `scrim` ink, never pure black.
- **Row height:** list rows 56 minimum; stat tiles 3 lines (label, figure,
  delta/sub); tab bar 56 + safe area.
- **A screen is a stack of sections**, each a `SectionHeader` over a `Card`
  (rows or tiles). Two to four stats side by side (`StatRow`) before a list.
  Lists inside one `Card pad="none"` with hairline dividers, not one card per row.
- **Every empty list gets an `EmptyState`**, every loading list gets
  `SkeletonRow`s. Refusal-free is not empty-shaming: "No blocked trades" is a
  good day.

## Primitives

All in `packages/ui/src/components`, exported from `@kanon/ui`. Use these; do
not hand-roll a panel.

| Component | Purpose |
|---|---|
| `Card` | The one surface. Variants `base`, `raised`, `outlined`, `interactive`; `pad` none/sm/md/lg; optional `elevation`, `href`, `onPress` |
| `SectionHeader` | Title with a signal tick, optional monospaced count, right-hand action link |
| `StatTile`, `StatRow`, `Delta`, `Label` | 11px ash uppercase label over a monospaced figure; delta always carries an arrow glyph; flat is neutral |
| `ListRow` | Leading icon tile or avatar, title, subtitle, trailing figure or chevron, pressable |
| `SegmentedControl` | 2 to 4 exclusive choices; `select` haptic |
| `Chip`, `FilterChip` | Static tag; pressable filter (selected inverts to bone) |
| `Badge` | Uppercase status label with optional glyph; `tone` is a meaning |
| `Avatar` | Square monogram tile |
| `IconButton` | Icon-only control; `label` is required |
| `EmptyState` | Icon, title, one-line body, next step |
| `Skeleton`, `SkeletonRow` | Loading shapes |
| `Divider` | Hairline, vertical or captioned |
| `ProgressRing`, `Sparkline` | Small SVG visuals; direction colour only beside a figure |
| `BottomSheet` | Sheets, not modals (existing) |
| `Icon` | The icon set |

Tones (`Tone`): `neutral`, `signal` (rule), `long`/`short` (direction only),
`refused` (block), `verified` (proof).

## Iconography

- One set: `Icon` in `components/icons.tsx`, drawn with react-native-svg on both
  platforms. Geometry is generated from lucide (ISC) by
  `packages/ui/scripts/gen-icons.mjs`; add a name to that script, never inline
  a path.
- Stroke 1.75 on the 24 grid, round caps and joins. 2 only for an active tab.
- Sizes: 12 (in a badge or delta), 14 (inline with 11 to 13px text), 16 (list
  tile), 18 (default), 20 (buttons), 22 (tab bar). Pick a size; do not scale.
- Colour is a token name (`color="ash"`). Decorative icons are hidden from
  assistive tech; an icon that stands alone gets a `label`.
- Never a placeholder square or dot as an icon. Direction icons (`trending-*`,
  `arrow-up/down`) sit beside a signed figure or a label, always.

## Haptics

`useHaptics()` from `@kanon/ui`: `tap` (light impact, presses), `select`
(segments, chips, tabs), `success` (a pin, a stake), `warning` (a cooling-off
begins), `refusal` (heavy impact; felt before it is read). No-op on the web.

## Screens

| Route | Export | Notes |
|---|---|---|
| `app/home` | `rule-card.png` | Home tab. Rule, adherence, small price line |
| `app/compile` | `compiler.png` | Chat above, live spec diff below |
| `app/compile/review` | `spec-review.png` | Plain/parametric toggle, editable |
| `app/compile/pin` | `pinning.png` | Ceremony. Hash, bond, biometric |
| `app/trades/proposal` | `proposal.png` | Satisfied predicates, undo countdown |
| `app/trades/[id]` | `trade-detail.png` | Evidence chain, verify link |
| `app/blocked` | `blocked-log.png` | Refusals, and how many would have lost |
| `app/rules/[id]/loosen` | `cooling-off.png` | Unskippable countdown, diff |
| `app/share/[id]` | `strategy-card.png` | Shareable, must work at thumbnail size |
| `app/onboarding` | `onboarding-*.png` | Three screens, ends in a text field |
| `app/chart`, `app/create`, `app/predict` | none yet | Chart, AI and Predict tabs |
| `app/profile` | none yet | Profile tab: account, appearance (theme), records, rules, copy trading, security |

## Consistency check

Before calling any screen done, compare its number treatment against
`rule-card`, `proposal`, `trade-detail` and `blocked-log`, in dark and in light. If the figures drift
in size, weight or alignment, the app stops reading as a single instrument.

## Test conditions

Mid-range Android, throttled connection. Skia charts must hold frame rate on
that device, not on a simulator. Check every screen in both themes at 390px.
