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

Five tabs, bottom-anchored on a phone or tablet and a left rail on desktop (see Responsive), in this order:

| Tab | Route | What it is |
|---|---|---|
| HOME | `/home` | The rule card and what the rule has done: the pinned rule, adherence, recent activity, small price line |
| CHART | `/chart` | Full-height chart, drawing tools, the rule overlaid on price |
| AI | `/create` | The strategy builder: talk to the model, watch the spec form. The raised centre button |
| PREDICT | `/predict` | Timed trades, as a reel |
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

## Responsive

One app, three shapes. The phone is the design's home; tablet and desktop are the
same screens given room, not a second product. There is no phone-shaped artboard
on the web: a screen fills its window.

| Layout | Width | Chrome | Content |
|---|---|---|---|
| Phone | under 640 | Bottom `TabBar` | Full-bleed |
| Tablet | 640 to 1023 | Bottom `TabBar` | Centred column, 720 max, edges drawn in `hairline` |
| Desktop | 1024 and up | `SideNav` on the left (232px, or a 56px icon rail when collapsed), no `TabBar` | The pane beside it, `column` 720, `wide` 1280 or `full` |

Native is unchanged: the screen is the viewport, the safe-area inset is the frame,
the bottom bar stays. Every rule below is web-only and gated on `isWeb`.

**Breakpoints are classes.** `sm:` (640) and `lg:` (1024) in Tailwind, so the
server-rendered markup is right at every width and hydration never flashes. The
numbers live in `packages/ui/src/lib/layout.ts` (`BREAKPOINTS`, `SHELL`), and the
classes in `components/shell` have to move with them. `useLayout()` returns
`'phone' | 'tablet' | 'desktop'` from `useWindowDimensions`, and is for what a
class cannot express (mounting a component, JS geometry). It says `'phone'` on the
server and the first client render, so a branch on it shows the phone form for one
frame on a wide screen.

**The shell is `Screen`.** Every screen keeps its structure, `Screen`, header,
`Body`, `TabBar`, and the shell does the rest. `TabBar` renders the bottom bar
below `lg` and tells the enclosing `Screen` which tab is current, so the rail
lights the same item. A screen with no tab (refusal, review, pinning) still gets
the rail, with nothing lit; `active` on `Screen` lights one for a sub-screen that
belongs under a tab.

| Piece | What it is |
|---|---|
| `Screen` | The frame. `size`: `column` (default), `wide`, `full`. `desktop` sets the pane from `lg` alone (`size="column" desktop="full"`: a column on a phone and tablet, the whole pane on desktop, so the tablet is untouched). `nav={false}` hides the rail (a full-screen chart). `active` for a screen with no `TabBar`. |
| `SideNav` | The desktop rail: brand, Home / Chart / AI / Predict / Profile, account chip. A `navigation` landmark, every item a real link with a `signal` focus ring, the current one `aria-current="page"`. |
| `TabBar` | The bottom bar, hidden from `lg`. |
| `Body` | The scrolling middle. Pass `size` to keep its own column inside a `wide` or `full` screen. |
| `Content` | A centred, gutter-padded container for a page inside its own scroller: `size` `column` or `wide`. |
| `Row`, `Col` | Stack below `lg`, side by side from `lg`. `Col span` is its share of twelve. |
| `SplitPane` | Main plus a fixed-width side panel (`sideWidth` 320, 360 or 420); stacks below `lg`, main first. `fill` makes the split the whole screen (a thread with a pinned composer); `desktopSide` draws the panel from `lg` only, so a phone keeps its own composition of that content. |

The rail's active item changes three things together, as the bottom bar's tab
does: a 2px `signal` bar, a `raised` ground, and `bone` icon and label. The AI item
keeps its `signal` tile always, the raised centre button's counterpart. The
account chip shows the signed-in name and handle, or the demo account, and opens
Profile.

**Composing for desktop.** Start from the phone stack and add, never fork.
A dashboard is `<Screen size="full">`, its own scroller, `<Content size="wide">`
inside it, and `Row`/`Col`/`SplitPane` for the two-column parts. The scroller spans
the pane so the wheel works everywhere; only the text keeps a readable width. A
`column` pane that leaves gutters forwards the wheel from them to its scroller.
Gutters are 20 on a phone, 32 on a tablet and 40 on desktop for `wide` and `full`,
and 20 throughout for a `column`, so it lines up with `NavBar` and `Footer`. The
rules above still hold: bottom sheets, not modals; P&L never above the fold; every
number monospaced.

**Chart, Predict and AI on desktop.** Each keeps its phone composition and adds a
desktop one by class (`hidden lg:flex` for what only desktop draws, `lg:hidden` for
what only a phone draws), so there is one tree and one chart instance.
Chart: a fixed 40px tool rail left of the canvas, a 44px toolbar (symbol, timeframe
strip, history, magnet, full screen), and a 264 to 300px panel with the symbol, the
list area, the pinned rule with its structure toggle, and the order ticket pinned
to the foot. The list area has two tabs. Markets is the watchlist (feed-backed
assets only). Trades is every open position on the shared trading account, each
with its own close, then the caller's own orders. The ticket sends a market order:
size and leverage are chips, every limit it is held to is in view, the answer (a
fill with its transaction, or a refusal in the server's words) is shown in place,
and no result of a position is shown. A fill's price, fee and transaction can
arrive a few seconds after the fill itself; they read "Not reported yet" until
they do. With a position open, the same side adds to it at the position's
leverage and the other side is off until it is closed. On a phone the bottom bar
opens the same ticket as a bottom sheet, and the order leaves from the sheet's
bottom-anchored action. Checking the market against the rule is the ticket's
secondary action. On the chart itself an open position draws a labelled line at
its entry price, and the caller's fills are marked on their candles: an open as
an arrow on its side, a close as a neutral square. Neither shows a result.

**The navigation collapses.** One button at the top of `SideNav` shrinks it to a
56px rail: each destination is its icon alone, still one press away, with its
name read out and shown on hover. The current destination keeps its mark, the
brand keeps its rod mark and the account its monogram. The choice is
remembered, and the pane beside it takes the width.

**Side panels collapse.** The chart's panel and both Predict panels shrink to a
40px rail with one button that opens them again, and the choice is remembered.
The chart's rail says what it hides and shows the side of any open position, so
a position is never out of sight. There is no slide: a moving width would resize
the chart on every frame.

Predict: a reel of timed trades. Full-screen slides paged vertically (swipe on a
phone; wheel, arrow and page keys on desktop, in a 440px centred column). A
slide is a pair and a time, not a price to reach: "Which way does BTC move in
the next 1 minute?". On it are the live price and its line filling the slide,
four facts taken from the server (size, that it closes itself after the slide's
time, the most it can lose, the slippage bound), the stake as chips, and UP and
DOWN at the foot. One press sends. While a trade runs on a pair, every slide of
that pair shows it instead of the two actions: the countdown is the largest
figure, the entry is a dashed line on the chart, and the move from entry is a
direction and a price distance, never money. A trade that has just ended leads
with the call and what the price did. Running trades on other pairs and the
caller's history open from a rail on every slide; a finished trade's money
result is one neutral row inside its bottom sheet, beside the two transaction
links. On desktop a left panel filters by pair and time and, from 1280, a right
panel lists what is running and the history. There is no "how it settles"
panel: the result is the venue's two fills. Signed out the reel is a labelled
sample, so a visitor can see and swipe it: the demo pairs at fixed times and
stakes, each slide badged `SAMPLE` over the demo price line, with UP, DOWN and
the one note under them leading to sign-in. It shows no trade, no countdown and
no result, and nothing is sent from it.
AI: `SplitPane` with the conversation held to
720 and the spec draft as an always-visible 360px panel instead of the dock. A bottom
sheet is a 560px panel centred at the foot of the pane from `lg`.

**Home and Profile on desktop.** Both are `<Screen size="column" desktop="wide">`, so
the phone and the tablet are untouched and only `lg` opens out. Home is a header row,
then a main column (the four behaviour tiles in one row, the rule, the pairs as a
table with pair, price, 24h change and the day's line, then the ledger) beside a side
column (traders to follow as stacked lead cards, an Ask the AI card that opens
`/create?prompt=…` with an example rule in the box and nothing sent, the Analytics and
Vault shortcuts). The P&L line is the last thing on the page, full width. The desktop
pair table has no 24h high or low because the ticker does not carry them. Profile is a
two-pane settings layout: a section list (Overview, Trading records, Previous rules,
Copy trading, Security, Appearance, Settings, About, Sign out) and the selected
section inline on the right. Each route selects its section, so `/profile/records`
opens Trading records and the browser's back button retraces sections; the four
sections with no route (Overview, Copy trading, Appearance, About) switch in place on
`/profile`, and `/profile?section=appearance` opens one. Trading records is a table
(day, asset with its source under it, side glyph, size, entry from `xl`, result or the
predicate that refused it, proof link) with the filter chips above it. A phone keeps
the push navigation.

**Perpl risk (`/risk`, reached from Profile).** One column on a phone, market cards two
across from `lg`. Top to bottom: what is worth a look (a position half-way or more to its
liquidation price, a wide book, a mark away from the oracle, crowded funding, a stale or
closed market), each as one sentence with its figure, or one calm line when nothing is
flagged; the account (free AUSD, AUSD inside positions, exposure at the mark, positions
flagged) and each position with its liquidation price and a meter of how much of the way
from entry to liquidation the mark has gone, labelled CLEAR, WATCH or NEAR; then every
market as a card of eight figures. Risk is a price and a distance, never money made or
lost. Direction colour appears only on a side and on the day's move, each with its arrow;
NEAR takes `short` with its word, WATCH and CLEAR stay neutral. The foot of the screen
says how the liquidation price is worked out and links to Perpl's formula. Signed out,
the markets are shown and the account asks for sign-in.

**One record for three ways of trading.** Trading records lists every trade the person
took, newest first by the day it was opened: a position from the chart's ticket, a
timed trade from Predict, and a setup put to their rule (executed or refused). Each row
names its source (`Chart`, `Predict`, `Rule`) and the chips filter by it (All, Chart,
Predict, By rule, Refused); the four tiles above are counts of the same. The server
records orders, not trades, so a chart trade is paired from the person's own orders:
every filled open and add on a market, up to the close that followed, with the entry
weighted by size. The orders a timed trade placed are left out of that pairing, since
the timed trade is already a row. A row carries a direction, a state and prices and
never money. Pressing a chart trade or a finished timed trade opens a bottom sheet with
its figures, the result among them, and each order's transaction on the explorer; a
rule's trade opens its evidence screen; a running timed trade goes to Predict.
`/profile/records?open=<id>` opens the screen on one record. The Profile tab shows the
newest five under "Your trades", each linking to that address, and its Trades tile
counts all three kinds.

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
| `app/blocked` | `blocked-log.png` | Refusals, and the loss they avoided (stated as Analytics states it, never as a loss) |
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
that device, not on a simulator. Check every screen in both themes at 390px, and the tab screens at 768, 1024 and 1440.
