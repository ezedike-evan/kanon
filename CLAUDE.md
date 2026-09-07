# Kanon

A trading app that enforces your own strategy against you. You describe your
rules in plain language, an AI compiles them into a machine-checkable spec, the
spec is pinned on-chain, and a contract refuses any trade that does not satisfy
it.

Built for the Monad Metropolis hackathon. Track: Onchain Finance & Trading.
Submission deadline: 13 October 2026.

Read `docs/PRODUCT.md` before writing product logic, `docs/DESIGN.md` before
writing UI, `docs/ARCHITECTURE.md` before touching the compiler, the oracle or
the contracts, and `docs/SCOPE.md` before agreeing to build anything not already
listed there.

`kanon` (κανών) is Greek for the rule and for the measuring rod you check things
against.

## Stack

Monorepo, pnpm workspaces. Two clients over one shared UI layer.

- `apps/web` — Next.js 15 App Router, React 19, react-native-web. The primary
  surface and what gets demoed.
- `apps/mobile` — Expo (React Native) with expo-router, expo-local-authentication,
  expo-secure-store, Reanimated.
- `packages/ui` — every screen and component, written once in React Native
  primitives and rendered on both clients through react-native-web.
- `packages/spec` — the strategy spec: Zod schema, versioned type, decimal
  helpers, hashing, diffing. Vitest lives here.
- `packages/tokens` — design tokens, built into a Tailwind preset by
  `scripts/build-preset.mjs`. Every client consumes the preset; no client
  defines its own colours.

TypeScript strict everywhere. NativeWind 4 for styling on both platforms. Zod for
all boundary validation.

## Commands

```
pnpm install
pnpm web                # next dev, apps/web
pnpm start              # expo dev server, apps/mobile
pnpm ios / pnpm android
pnpm build              # tokens + next build
pnpm test               # vitest, packages/spec
pnpm typecheck          # tokens + every workspace
pnpm lint               # eslint, apps/web
```

`pnpm tokens` runs first in every script that needs styling. If Tailwind classes
resolve to nothing, the preset was not built.

## Conventions

- Screens live in `packages/ui/src/screens/`, one file per screen. A route file
  in `apps/web/app/` or `apps/mobile/app/` does nothing but import one and mount
  it. No screen logic in a route file.
- Write React Native primitives (`View`, `Text`, `Pressable`), never `div`/`span`.
  Web gets them through react-native-web. Platform splits go in
  `packages/ui/src/platform.tsx`, not inline.
- File-based routing on both clients, route names shared via
  `packages/ui/src/lib/routes.ts`.
- The strategy spec is a Zod schema and a versioned type. It is the single source
  of truth shared by the compiler, the UI and the contract encoder.
- Prices and sizes are integers with explicit decimals. Never floats.
- Monospaced tabular figures for every number in the UI, without exception.
- Bottom sheets, not modals. Primary actions bottom-anchored.

## Hard rules

These come from the security model. Breaking one collapses the entire pitch.

**The contract never calls a model.** Not directly, not through an oracle, not
through a resolver. It verifies signatures and does arithmetic. Nothing else.

**No predicate ships unless it is arithmetic over signed price data.** If a rule
cannot be expressed that way, it does not go in the spec. The AI must bind it to
parameters or drop it.

**The second agent is a challenger, not a judge.** It may be as smart and as
fuzzy as it likes, because its opinion carries no weight. It submits evidence
that makes a claim arithmetically false. It never asserts that a claim is false.
Two models agreeing is correlation, not verification.

**No hidden parameters.** Every default the compiler chose is surfaced in the
spec review and is editable. A user discovering an unseen parameter after
unexpected behaviour is a permanent loss of trust.

**Compilation is always reviewed, never silent.** The user sees the spec in plain
English and in parametric form and signs off before anything is pinned.

**Tightening a rule is immediate. Loosening waits out a cooling-off period.**
There is no override, no admin path, no support escape hatch. The constraint is
the product.

**Refusal is a success state.** Never style a block as an error. Never apologise
for it in copy.

**P&L never appears above the fold.** Leading with profit drives the behaviour
this product exists to prevent.

## Definition of done for a screen

- Matches the corresponding PNG in `design/` at a glance
- Every number monospaced and tabular, consistent across screens
- Renders from `packages/ui`, mounted by a route file on both clients
- Works one-handed in portrait
- Renders correctly on a mid-range Android and in the browser at 390px wide
- No hardcoded hex values
- Evidence reachable in one tap wherever a claim is displayed
