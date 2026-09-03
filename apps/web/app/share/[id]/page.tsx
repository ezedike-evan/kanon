import { formatBps } from '@kanon/spec';
import { Footer, NavBar, Screen } from '@/components/chrome';
import { Dot, GhostButton, Meta, Num, PrimaryButton } from '@/components/ui';
import { RULE, SHARE_CARD } from '@/lib/demo';

/**
 * 09 · SHAREABLE STRATEGY CARD.
 *
 * The growth loop, and the one artifact that leaves the app. It has to survive
 * being seen at thumbnail size, so the two figures that matter — adherence and
 * verified P&L — carry the card and everything else is supporting text.
 *
 * Nothing on it is self-reported. The link at the bottom is the whole claim.
 */
export default async function StrategyCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await params;

  return (
    <Screen label="09 · SHAREABLE STRATEGY CARD">
      <NavBar
        left={`←  ${RULE.ordinal}`}
        leftHref="/"
        leftClassName="text-ash tracking-w12"
        right="SHARE CARD"
      />

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5">
        <div className="border border-hairline bg-panel">
          <div className="border-b border-hairline px-4.5 pt-4.5 pb-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-11 font-bold tracking-w22">KANON</span>
              <div className="flex items-center gap-1.5">
                <Dot className="bg-verified" />
                <span className="font-mono text-9 tracking-w16 text-verified">
                  VERIFIED ON-CHAIN
                </span>
              </div>
            </div>
            <div className="mt-5 font-mono text-18 font-medium tracking-t20">
              {RULE.name}
            </div>
            <div className="mt-2.5 flex gap-3.5 font-mono text-10 tracking-w10 text-ash">
              <Num>{RULE.asset}</Num>
              <Num>{RULE.timeframe}</Num>
              <Num>{SHARE_CARD.window}</Num>
            </div>
          </div>

          {/* The spec itself, compressed. A reader can check it against the hash. */}
          <div className="flex flex-col gap-2 border-b border-hairline px-4.5 py-3.5">
            {SHARE_CARD.summary.map((line) => (
              <Num key={line} className="text-11p5 text-ash">
                {line}
              </Num>
            ))}
          </div>

          <div className="flex border-b border-hairline">
            <div className="flex flex-1 flex-col gap-2 pt-4 pb-3.5 pl-4.5">
              <Meta className="tracking-w16">ADHERENCE</Meta>
              <Num className="text-30 leading-[0.9] font-medium tracking-t35 text-signal">
                {formatBps(SHARE_CARD.adherenceBps, { dp: 1 })}
              </Num>
            </div>
            <div className="flex flex-1 flex-col items-end gap-2 pt-4 pr-4.5 pb-3.5">
              <Meta className="tracking-w16">VERIFIED P&amp;L</Meta>
              <Num className="text-30 leading-[0.9] font-medium tracking-t35 text-long">
                {formatBps(SHARE_CARD.verifiedPnlBps, { signed: true, dp: 1 })}
              </Num>
            </div>
          </div>

          <div className="flex border-b border-hairline">
            <div className="flex flex-1 flex-col gap-1.75 py-3.25 pl-4.5">
              <Meta className="tracking-w16">TAKEN</Meta>
              <Num className="text-15 font-medium">{SHARE_CARD.taken}</Num>
            </div>
            <div className="flex flex-1 flex-col gap-1.75 py-3.25">
              <Meta className="tracking-w16">BLOCKED</Meta>
              <Num className="text-15 font-medium">{SHARE_CARD.blocked}</Num>
            </div>
            <div className="flex flex-1 flex-col items-end gap-1.75 py-3.25 pr-4.5">
              <Meta className="tracking-w16">OVERRIDES</Meta>
              {/* Zero, and it can only ever be zero. There is no override path. */}
              <Num className="text-15 font-medium">{SHARE_CARD.overrides}</Num>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 bg-raised px-4.5 py-3.25">
            <Num className="text-11 text-ash">{SHARE_CARD.url}</Num>
            <span className="font-mono text-10 tracking-w10 text-verified">
              CHECK IT ↗
            </span>
          </div>
        </div>
        <p className="mt-3.5 font-mono text-10 leading-[1.5] text-ash">
          {SHARE_CARD.disclaimer}
        </p>
      </div>

      <Footer className="flex gap-2.5">
        <GhostButton className="flex-1 py-4.25 text-12 tracking-w12">
          SAVE IMAGE
        </GhostButton>
        <PrimaryButton className="flex-1 py-4.25 text-12 tracking-w12">
          SHARE
        </PrimaryButton>
      </Footer>
    </Screen>
  );
}
