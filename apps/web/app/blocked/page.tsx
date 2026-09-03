import Link from 'next/link';
import { formatDecimal } from '@kanon/spec';
import { Body, Screen, StatusBar, TabBar } from '@/components/chrome';
import { Dot, Meta, Num } from '@/components/ui';
import { BLOCKED } from '@/lib/demo';

/**
 * 07 · BLOCKED TRADES LOG.
 *
 * Trades refused, and how many would have lost. Adherence is the primary
 * metric, and this is where it is earned. Nothing here is styled as an error
 * and nothing apologises: a refusal is the product working.
 */
export default function BlockedLogPage() {
  return (
    <Screen rail="bg-hairline" label="07 · BLOCKED TRADES LOG">
      <StatusBar />
      <div className="flex shrink-0 items-center justify-between px-5 pt-5.5">
        <span className="font-mono text-11 tracking-w16">BLOCKED</span>
        <span className="font-mono text-10 tracking-w12 text-ash">
          {BLOCKED.period}
        </span>
      </div>

      <Body>
        <div className="mt-5.5 flex border-y border-hairline">
          <div className="flex flex-1 flex-col gap-2 py-4">
            <Meta>REFUSED</Meta>
            <Num className="text-31 leading-[0.9] font-medium tracking-t30">
              {String(BLOCKED.refused).padStart(2, '0')}
            </Num>
          </div>
          <div className="flex flex-[1.5] flex-col items-end gap-2 py-4">
            <Meta>WOULD HAVE LOST</Meta>
            <Num className="text-31 leading-[0.9] font-medium tracking-t30">
              {formatDecimal(BLOCKED.wouldHaveLost)}
            </Num>
          </div>
        </div>
        <p className="mt-2.5 font-mono text-10 leading-[1.5] text-ash">
          {BLOCKED.note}
        </p>

        <div className="mt-6 flex flex-col pb-5">
          {BLOCKED.rows.map((row, i) => (
            <Link
              key={`${row.symbol}-${row.at}`}
              href="/refused"
              className="flex gap-3 border-t border-hairline py-3.5"
            >
              <Dot className="mt-1.25 bg-refused" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-12 font-medium">{row.symbol}</span>
                  <Num className="text-10 text-ash">{row.at}</Num>
                </div>
                {/* The predicate, and the number that failed it. Always both. */}
                <Num className="text-11p5 text-ash">{row.detail}</Num>
              </div>
              <span className="sr-only">
                Refusal {i + 1} of {BLOCKED.rows.length}
              </span>
            </Link>
          ))}
        </div>
      </Body>

      <TabBar active="trades" />
    </Screen>
  );
}
