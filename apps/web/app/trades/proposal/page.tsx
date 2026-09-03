import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, BrandBar, Footer, Screen, StatusBar } from '@/components/chrome';
import { UndoCountdown } from '@/components/countdown';
import { DangerButton, Dot, Meta, Num, Panel } from '@/components/ui';
import { PROPOSAL, RULE } from '@/lib/demo';

/**
 * 05 · TRADE PROPOSAL · UNDO WINDOW.
 *
 * The setup satisfied the spec, so it executes. Each predicate is shown beside
 * the arithmetic that satisfied it — the same comparison the contract made, in
 * the same direction, with the same numbers.
 */
export default function ProposalPage() {
  return (
    <Screen rail="bg-long" label="05 · TRADE PROPOSAL · UNDO WINDOW">
      <StatusBar />
      <BrandBar status={`${RULE.ordinal} SATISFIED`} />

      <Body>
        <div className="mt-7.5 flex items-center gap-2.25">
          <Dot className="size-2 bg-long" />
          <span className="font-mono text-11 font-bold tracking-w20 text-long">
            SETUP VALID · EXECUTING
          </span>
        </div>
        <h1 className="mt-3.5 text-30 leading-[1.08] font-medium tracking-t25">
          Long {RULE.asset.replace(/ /g, '')}
        </h1>

        <Panel className="mt-6">
          {(
            [
              ['ENTRY', PROPOSAL.entry],
              ['STOP', PROPOSAL.stop],
              ['TARGET', PROPOSAL.target],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="flex items-end justify-between border-b border-hairline px-4 py-3.25"
            >
              <Meta>{label}</Meta>
              <Num className="text-26 font-medium tracking-t30">
                {formatDecimal(value)}
              </Num>
            </div>
          ))}
          <div className="flex gap-5 bg-raised px-4 py-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Meta>SIZE</Meta>
              <Num className="text-15 font-medium">
                {formatDecimal(PROPOSAL.size)} BTC
              </Num>
            </div>
            <div className="flex flex-1 flex-col items-end gap-1.5">
              <Meta>RISK / ACCOUNT</Meta>
              <Num className="text-15 font-medium">{formatBps(PROPOSAL.riskBps)}</Num>
            </div>
          </div>
        </Panel>

        <div className="mt-5.5 mb-5 flex flex-col">
          <Meta className="pb-2.5 tracking-w20">
            PREDICATES SATISFIED · <Num>{PROPOSAL.checks.length}</Num> /{' '}
            <Num>{PROPOSAL.checks.length}</Num>
          </Meta>
          {PROPOSAL.checks.map((check, i) => (
            <div
              key={check.label}
              className={`flex items-center justify-between gap-3 border-t border-hairline py-2.75 ${
                i === PROPOSAL.checks.length - 1 ? 'border-b' : ''
              }`}
            >
              <div className="flex items-center gap-2.5">
                {/* Green is load-bearing here, so it is paired with a glyph. */}
                <span className="font-mono text-12 text-long" aria-hidden>
                  ✓
                </span>
                <span className="font-mono text-12">{check.label}</span>
              </div>
              <Num className="text-12 text-ash">{check.evidence}</Num>
            </div>
          ))}
        </div>
      </Body>

      <Footer>
        <div className="mb-4 flex items-end justify-between border-t border-hairline py-4">
          <div className="flex flex-col gap-1.75">
            <Meta>UNDO WINDOW</Meta>
            <span className="font-mono text-10 tracking-w06 text-ash">
              Executes automatically at <Num>00:00</Num>
            </span>
          </div>
          <UndoCountdown
            seconds={PROPOSAL.undoSeconds}
            className="text-34 leading-[0.9] font-medium tracking-t30"
          />
        </div>
        <DangerButton href="/blocked">CANCEL TRADE</DangerButton>
      </Footer>
    </Screen>
  );
}
