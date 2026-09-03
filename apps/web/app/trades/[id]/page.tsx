import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '@/components/chrome';
import { EvidenceChain } from '@/components/evidence-chain';
import { EvidenceLink, Meta, Num } from '@/components/ui';
import { RULE, TRADE } from '@/lib/demo';
import { shareRoute } from '@/lib/routes';

/**
 * 06 · TRADE DETAIL · EVIDENCE.
 *
 * The result is stated once and the evidence chain gets the rest of the screen.
 * If verification took more than one tap, "verifiable" would be marketing and
 * this audience would treat it as marketing.
 */
export default async function TradeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Screen rail="bg-hairline" label="06 · TRADE DETAIL · EVIDENCE">
      <NavBar
        left="←&nbsp;&nbsp;TRADES"
        leftHref="/blocked"
        leftClassName="text-ash tracking-w12"
        right={`TRADE ${id.toUpperCase()}`}
      />

      <Body>
        <div className="mt-6.5 flex items-end justify-between">
          <div className="flex flex-col gap-2.25">
            <span className="font-mono text-11 tracking-w14 text-long">
              {TRADE.side}
            </span>
            <Num className="text-20 font-medium tracking-t20">{RULE.asset}</Num>
          </div>
          <div className="flex flex-col items-end gap-1.75">
            <Meta>RESULT</Meta>
            <Num className="text-31 leading-[0.9] font-medium tracking-t30 text-long">
              {formatDecimal(TRADE.result, { signed: true })}
            </Num>
          </div>
        </div>

        <div className="mt-5.5 flex border-y border-hairline">
          <div className="flex flex-1 flex-col gap-1.75 py-3.25">
            <Meta>ENTRY</Meta>
            <Num className="text-15 font-medium">{formatDecimal(TRADE.entry)}</Num>
          </div>
          <div className="flex flex-1 flex-col gap-1.75 py-3.25">
            <Meta>EXIT</Meta>
            <Num className="text-15 font-medium">{formatDecimal(TRADE.exit)}</Num>
          </div>
          <div className="flex flex-1 flex-col items-end gap-1.75 py-3.25">
            <Meta>RETURN</Meta>
            <Num className="text-15 font-medium text-long">
              {formatBps(TRADE.returnBps, { signed: true })}
            </Num>
          </div>
        </div>

        <Meta className="mt-6.5 tracking-w20">
          EVIDENCE CHAIN · <Num>{TRADE.claims.length}</Num> CLAIMS
        </Meta>
        <EvidenceChain claims={TRADE.claims} />
        <div className="pb-5" />
      </Body>

      <Footer>
        <EvidenceLink label="Verify on-chain" hash={RULE.txAbbrev} href={shareRoute(RULE.id)} />
      </Footer>
    </Screen>
  );
}
