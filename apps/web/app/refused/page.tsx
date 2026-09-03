import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, BrandBar, Footer, Screen, StatusBar } from '@/components/chrome';
import { Dot, EvidenceLink, GhostButton, Meta, Num, Panel } from '@/components/ui';
import { REFUSAL, RULE, TRADE_ID } from '@/lib/demo';
import { tradeRoute } from '@/lib/routes';

/**
 * 00 · REFUSAL.
 *
 * Full-bleed, never a toast. It names the predicate that failed and the number
 * that failed it. Refusal is a success state: nothing here apologises, and
 * nothing here is styled as an error.
 */
export default function RefusedPage() {
  return (
    <Screen rail="bg-refused" label="00 · REFUSAL">
      <StatusBar />
      <BrandBar />

      <Body className="animate-refuse">
        <div className="mt-11 flex items-center gap-2.25">
          <Dot className="size-2 bg-refused" />
          <span className="font-mono text-11 font-bold tracking-w20 text-refused">
            REFUSED ON-CHAIN
          </span>
        </div>

        <h1 className="mt-3.5 text-34 leading-[1.06] font-medium tracking-t25 text-pretty">
          Trade blocked by your own rule.
        </h1>

        <div className="mt-8.5 flex flex-col gap-2.5 border-t border-hairline pt-3.5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-10 tracking-w16 text-signal">
              {RULE.ordinal}
            </span>
            <span className="font-mono text-13 font-medium">{REFUSAL.predicate}</span>
          </div>
          <p className="font-mono text-13 leading-[1.5] text-ash text-pretty">
            {REFUSAL.reason}
          </p>
        </div>

        <Panel className="mt-7.5">
          <div className="flex items-end justify-between gap-4.5 border-b border-hairline px-4 pt-4 pb-3.5">
            <div className="flex flex-col gap-1.75">
              <Meta>REQUIRED HIGH</Meta>
              <span className="font-mono text-10 tracking-w10 text-ash">PRIOR SWING</span>
            </div>
            <Num className="text-31 font-medium tracking-t30">
              {formatDecimal(REFUSAL.requiredHigh)}
            </Num>
          </div>
          <div className="flex items-end justify-between gap-4.5 border-b border-hairline px-4 pt-4 pb-3.5">
            <div className="flex flex-col gap-1.75">
              <Meta>CURRENT PRICE</Meta>
              <span className="font-mono text-10 tracking-w10 text-ash">
                {RULE.asset} · {RULE.timeframe}
              </span>
            </div>
            <Num className="text-31 font-medium tracking-t30">
              {formatDecimal(REFUSAL.currentPrice)}
            </Num>
          </div>
          {/* The number that failed it, given its own row and its own colour. */}
          <div className="flex items-center justify-between bg-raised px-4 py-3">
            <Meta>SHORTFALL</Meta>
            <div className="flex items-baseline gap-2.5">
              <Num className="text-11 text-ash">{formatBps(REFUSAL.shortfallBps)}</Num>
              <Num className="text-18 font-medium tracking-t20 text-refused">
                {formatDecimal(REFUSAL.shortfall)}
              </Num>
            </div>
          </div>
        </Panel>

        <div className="mt-4.5 mb-5 flex items-center justify-between font-mono text-10 tracking-w08 text-ash">
          <Num>{REFUSAL.at}</Num>
          <Num>BLOCK {REFUSAL.block}</Num>
        </div>
      </Body>

      <Footer>
        <EvidenceLink
          className="mb-4.5"
          label="View on-chain evidence"
          hash={RULE.txAbbrev}
          href={tradeRoute(TRADE_ID)}
        />
        <GhostButton href="/">ACKNOWLEDGE</GhostButton>
      </Footer>
    </Screen>
  );
}
