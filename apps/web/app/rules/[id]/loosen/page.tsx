import { COOLING_OFF_SECONDS, diffSpec, formatBps } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '@/components/chrome';
import { CoolingOffCountdown } from '@/components/countdown';
import { GhostButton, Meta, Num } from '@/components/ui';
import { COOLING_OFF, PENDING_SPEC, RULE, SPEC } from '@/lib/demo';

/** Parameters are basis points in the spec; the diff shows them as percentages. */
const LABEL: Record<string, string> = {
  risk_per_trade: 'risk_per_trade',
  stop_distance: 'stop_distance',
};

/**
 * 08 · COOLING-OFF.
 *
 * Tightening a rule is immediate. Loosening one waits, with a visible,
 * unskippable countdown. The friction is the product, so it is rendered rather
 * than hidden — and the old parameters stay enforced the whole time.
 */
export default async function CoolingOffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await params;
  // The classification comes from @kanon/spec, not from this screen: the same
  // function decides what the contract will accept immediately and what waits.
  const diff = diffSpec(SPEC, PENDING_SPEC);

  return (
    <Screen label="08 · COOLING-OFF">
      <NavBar
        left="COOLING OFF"
        leftClassName="text-signal"
        leftHref="/"
        right={RULE.ordinal}
      />

      <Body>
        <Meta className="mt-11 tracking-w20">CHANGE APPLIES IN</Meta>
        <CoolingOffCountdown
          requestedAt={COOLING_OFF.requestedAt}
          holdSeconds={COOLING_OFF_SECONDS}
          nowAt={COOLING_OFF.nowAt}
        />
        <span className="mt-3 font-mono text-10 tracking-w08 text-ash">
          {COOLING_OFF.requestedLabel}
        </span>

        <h1 className="mt-10 text-26 leading-[1.14] font-medium tracking-t20 text-pretty">
          You are loosening a rule you pinned.
        </h1>

        <div className="mt-6.5 border border-hairline bg-panel">
          <div className="border-b border-hairline px-3.5 py-3">
            <Meta>PENDING DIFF</Meta>
          </div>
          {diff.changes.map((change, i) => (
            <div
              key={change.path}
              className={`flex items-center justify-between gap-3 px-3.5 py-3.25 ${
                i < diff.changes.length - 1 ? 'border-b border-hairline' : ''
              }`}
            >
              <span className="font-mono text-12 text-ash">
                {LABEL[change.path] ?? change.path}
              </span>
              <div className="flex items-baseline gap-3">
                <Num className="text-15 text-ash line-through">
                  {formatBps(Number(change.before))}
                </Num>
                <span className="font-mono text-11 text-ash" aria-hidden>
                  →
                </span>
                <Num className="text-18 font-medium text-signal">
                  {formatBps(Number(change.after))}
                </Num>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5.5 flex flex-col gap-2.5 border-t border-hairline pt-4">
          <div className="flex justify-between font-mono text-11p5">
            <span className="text-ash">TIGHTENING A RULE</span>
            <span>IMMEDIATE</span>
          </div>
          <div className="flex justify-between font-mono text-11p5">
            <span className="text-ash">LOOSENING A RULE</span>
            <span className="text-signal">
              <Num>24</Num> HOUR HOLD
            </span>
          </div>
        </div>
        <p className="mt-3.5 mb-5 text-13p5 leading-[1.5] text-ash text-pretty">
          Until then the old parameters stay enforced. Nothing about your current
          rule changes while you wait.
        </p>
      </Body>

      <Footer>
        <GhostButton href="/">WITHDRAW CHANGE</GhostButton>
      </Footer>
    </Screen>
  );
}
