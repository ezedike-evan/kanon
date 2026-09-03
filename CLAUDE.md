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

- Expo (React Native) with expo-router, TypeScript strict
- NativeWind for styling
- Reanimated for motion, Skia for charts, FlashList for lists
- expo-local-authentication, expo-secure-store
- Zod for all boundary validation, and for the strategy spec schema
- Vitest for unit tests
- pnpm

## Commands

```
pnpm install
pnpm start              # expo dev server
pnpm ios / pnpm android
pnpm test
pnpm typecheck
pnpm lint
```

## Conventions

- File-based routing under `app/`. Route names match the design exports in `design/`.
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
- Works one-handed in portrait
- Renders correctly on a mid-range Android
- No hardcoded hex values
- Evidence reachable in one tap wherever a claim is displayed
