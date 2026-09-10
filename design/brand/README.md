# Kanon — Brand marks

Four directions. `rod` is the recommended primary.

| File | Name | Idea |
|---|---|---|
| `kanon-rod.svg` | Rod | The literal kanon: a measuring rod with graduations, one of them calibrated and extended in `signal`. The rule you check things against, which is what the word means. |
| `kanon-ceiling.svg` | Ceiling | A `signal` bar with a `bone` form stopped short beneath it. The refusal, drawn without a candlestick anywhere near it. |
| `kanon-kappa.svg` | Kappa | A `K` whose arms are cut away from the stem by a fixed gap. The upper arm is `signal`: the rule sits above the position it governs. |
| `kanon-bounds.svg` | Bounds | Two brackets and a value held between them. Reads as a spec constraint at any size. |

Each mark also ships as `*-mono.svg` in `currentColor`, for single-colour
contexts: the share card at thumbnail size, attestation stamps, print.

## Colour

Marks use tokens only, never new hex:

- `bone` `#E6EAEE` — the structure
- `signal` `#D4A017` — the rule, and only ever the rule
- `void` `#0B0D10` — the ground

`long`, `short` and `refused` are load-bearing for market direction and for the
block screen. None of them may appear in the mark, or the brand starts arguing
with the interface.

## Geometry

100 x 100 viewBox. Every corner is square, every join is mitred, every cap is
butt. Nothing in these marks is rounded, on purpose: `docs/DESIGN.md` asks for
tight corners and the mark is where that promise is made first.

`rod` is built on a 5 step graduation at y 21.5 / 36.5 / 50 / 64.5 / 78.5, tick
lengths 26 / 16 / 64 / 16 / 26. The long tick is the only asymmetry.

## Clear space and minimum size

Clear space is 8 units on all sides, scaled with the mark. Minimum size is 16 px
for `rod`, `kappa` and `bounds`. `ceiling` needs 24 px before its refusal gap
closes up, so use `rod` for the favicon.

## Lockup

Wordmark is `KANON`, uppercase, in the app's mono at 700 with 0.14em tracking.
Mono is not a style choice here: `CLAUDE.md` requires monospaced tabular figures
everywhere, and the wordmark is held to the same instrument.

- Horizontal: mark height equals cap height x 1.9, gap equals 0.5 x mark width.
- Stacked: mark above, gap equals 0.4 x mark height, wordmark tracked to the
  mark's width so the two edges align.

Set the wordmark in `bone`. `signal` on the wordmark makes the whole brand look
like a warning instead of a rule.

## Shipped icons

`rod` is the chosen mark. Rendered from `kanon-rod.svg` onto `void`.

```
apps/web/public/favicon.ico              16 + 32 + 48
apps/web/public/icons/favicon.svg        small cut, scalable
apps/web/public/icons/favicon-{16,32,48}.png
apps/web/public/icons/icon.svg           full mark, scalable
apps/web/public/icons/icon-{192,512}.png       mark at 62 percent
apps/web/public/icons/maskable-{192,512}.png   mark at 44 percent
apps/web/public/icons/apple-touch-icon.png     180
apps/mobile/assets/icon.png                    1024
apps/mobile/assets/favicon.png                 48
apps/mobile/assets/android-icon-foreground.png 1024, transparent
apps/mobile/assets/android-icon-background.png 1024, solid void
apps/mobile/assets/android-icon-monochrome.png 1024, black on transparent
```

The favicon slots use a three graduation cut of the rod rather than five. At
16 px the full mark gives each tick about one pixel with a one pixel gap, and
the graduations close into a solid block. The small cut keeps the top tick, the
signal rule and the bottom tick, on a wider stem, so the instrument still reads.

`app/manifest.ts` and the `icons` block in `app/layout.tsx` both point here, and
both take their colours from `@kanon/tokens`. Regenerate after any change to
`kanon-rod.svg`. Nothing here is hand edited.
