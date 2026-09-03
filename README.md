# Kanon

Your trading strategy, compiled into a contract that refuses trades breaking
your own rules — including the ones you would have broken yourself.

See `docs/PRODUCT.md` for the thesis, `docs/ARCHITECTURE.md` for the security
model, `docs/DESIGN.md` for the visual language and `docs/SCOPE.md` for what is
and is not being built.

## Layout

pnpm workspace monorepo.

```
apps/
  web/          Next.js App Router. Every screen in the design canvas.
packages/
  spec/         The strategy spec: Zod schema, diffing, hashing, fixtures.
  tokens/       Design tokens. Generates the Tailwind theme.
docs/           Product, architecture, design and scope.
```

`packages/spec` is the single source of truth `docs/ARCHITECTURE.md` calls for —
the compiler, the UI and the contract encoder all read the same schema. It is
pure TypeScript with no platform dependency, so the Expo client named in
`CLAUDE.md` consumes it unchanged when it lands alongside `apps/web`.

`packages/tokens` is likewise platform-neutral: `src/index.ts` is the source, and
`pnpm --filter @kanon/tokens build` generates `tokens.css` (the Tailwind v4
`@theme` block the web app imports) from it. The same file exports
`tailwindColors`, ready to drop into `theme.extend.colors` of a NativeWind
config. Editing the CSS by hand is a mistake — it is generated, and gitignored.

## Commands

```
pnpm install
pnpm dev                # builds tokens, then runs the web app
pnpm build
pnpm start
pnpm test               # vitest, across the workspace
pnpm typecheck
pnpm lint
```

## Screens

`/screens` renders every artboard at 393×852 in one canvas, each frame the real
route rather than a copy. It is the consistency check `docs/DESIGN.md` asks for:
number treatment drifts between screens in ways that are only visible side by
side.

| Route | Screen |
|---|---|
| `/refused` | 00 · Refusal |
| `/` | 01 · Rule card (home) |
| `/compile` | 02 · Chat-to-spec compiler |
| `/compile/review` | 03 · Spec review |
| `/compile/pin` | 04 · Pinning ceremony |
| `/trades/proposal` | 05 · Trade proposal · undo window |
| `/trades/[id]` | 06 · Trade detail · evidence |
| `/blocked` | 07 · Blocked trades log |
| `/rules/[id]/loosen` | 08 · Cooling-off |
| `/share/[id]` | 09 · Shareable strategy card |
| `/onboarding`, `/onboarding/fund`, `/onboarding/strategy` | 10A–C · Onboarding |

The design is drawn against a phone. On a narrow viewport the screen is the
viewport; on a wide one the device sits on the `canvas` ground with its artboard
label above it.

## What is real and what is demo state

The screens are wired to `apps/web/lib/demo.ts`, which carries the figures from
the design canvas. Two things are not mocked:

- **Tighten versus loosen.** The cooling-off screen's diff comes from
  `diffSpec()` in `@kanon/spec`, the same function that decides what a contract
  would accept immediately and what has to wait out the 24-hour hold. Anything
  that cannot be *proven* to be a tightening is treated as a loosening.
- **Figures.** Prices and sizes are fixed-point integers with explicit decimals,
  and percentages are basis points. No float ever reaches a screen.

There is no oracle, no contract and no execution yet; those are weeks 1–5 of
`docs/SCOPE.md`.
