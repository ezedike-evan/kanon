import Link from 'next/link';
import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, BrandBar, Screen, StatusBar, TabBar } from '@/components/chrome';
import { Dot, Meta, Num, Panel } from '@/components/ui';
import { HOME, RULE, TRADE_ID } from '@/lib/demo';
import { tradeRoute } from '@/lib/routes';
import { cx } from '@/lib/cx';

/**
 * 01 · RULE CARD — home.
 *
 * The rule outranks the chart. The strategy is the hero; the price line is
 * small, monochrome and last. P&L sits below the fold of the rule card, never
 * above it — leading with profit drives the behaviour this product exists to
 * prevent.
 */
export default function RuleCardPage() {
  return (
    <Screen label="01 · RULE CARD (HOME)">
      <StatusBar />
      <BrandBar />

      <Body>
        <Meta className="mt-7.5 text-9 tracking-w20">ACTIVE STRATEGY</Meta>

        {/* Tapping the rule is how you reach the chart, not the other way round. */}
        <Panel className="mt-3">
          <Link href="/compile/review" className="block border-b border-hairline px-4 pt-4 pb-3.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-10 tracking-w16 text-signal">
                {RULE.ordinal}
              </span>
              <div className="flex items-center gap-1.5">
                <Dot className="bg-signal" />
                <span className="font-mono text-9 tracking-w16 text-signal">
                  PINNED ON-CHAIN
                </span>
              </div>
            </div>
            <div className="mt-3 font-mono text-17 font-medium tracking-t20">
              {RULE.name}
            </div>
            <div className="mt-2.5 flex gap-3.5 font-mono text-11 tracking-w08 text-ash">
              <Num>{RULE.asset}</Num>
              <Num>{RULE.timeframe}</Num>
              <Num>{RULE.pinnedOn}</Num>
            </div>
          </Link>

          <div className="flex flex-col gap-2.75 px-4 pt-3.5 pb-4">
            <Meta className="text-9 tracking-w20">
              COMPILED PREDICATES · {RULE.predicates.length}
            </Meta>
            {RULE.predicates.map((text) => (
              <div key={text} className="flex items-start gap-2.5">
                <Dot className="mt-1.5 bg-signal" />
                <span className="font-mono text-12p5 leading-[1.45]">{text}</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* Adherence is the primary metric. It is the largest figure on the screen. */}
        <div className="mt-6.5 flex border-y border-hairline">
          <div className="flex flex-1 flex-col gap-2 pt-4 pb-3.5">
            <Meta>TAKEN</Meta>
            <Num className="text-20 font-medium tracking-t20">{HOME.taken}</Num>
          </div>
          <div className="flex flex-1 flex-col gap-2 pt-4 pb-3.5">
            <Meta>BLOCKED</Meta>
            <div className="flex items-center gap-1.75">
              <Dot className="bg-refused" />
              <Num className="text-20 font-medium tracking-t20">
                {String(HOME.blocked).padStart(2, '0')}
              </Num>
            </div>
          </div>
          <Link
            href="/blocked"
            className="flex flex-[1.3] flex-col items-end gap-2 pt-4 pb-3.5"
          >
            <Meta>ADHERENCE</Meta>
            <Num className="text-34 leading-[0.9] font-medium tracking-t35">
              {formatBps(HOME.adherenceBps, { dp: 1 })}
            </Num>
          </Link>
        </div>

        <div className="mt-3.5 flex items-center justify-between font-mono text-11 tracking-w06 text-ash">
          <span>P&amp;L · 30D</span>
          <Num className="text-long">
            {formatDecimal(HOME.pnl30d, { signed: true })}
          </Num>
        </div>

        <Link href={tradeRoute(TRADE_ID)} className="mt-auto block pb-5">
          <div className="flex items-end justify-between">
            <div className="flex flex-col gap-1.75">
              <Meta>{RULE.asset}</Meta>
              <Num className="text-26 font-medium tracking-t30">
                {formatDecimal(HOME.price)}
              </Num>
            </div>
            <Num className="text-11 text-refused">{formatBps(HOME.changeBps)}</Num>
          </div>
          <div className="mt-3.5 flex h-11 items-end gap-0.5" aria-hidden>
            {HOME.sparkline.map((height, i) => (
              <div
                key={i}
                style={{ height: `${height}%` }}
                className={cx(
                  'flex-1',
                  i >= HOME.sparkline.length - HOME.sparklineHead
                    ? 'bg-ash'
                    : 'bg-hairline',
                )}
              />
            ))}
          </div>
        </Link>
      </Body>

      <TabBar active="rules" />
    </Screen>
  );
}
