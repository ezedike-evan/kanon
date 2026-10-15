import { Text, View } from 'react-native';
import { formatBps, formatDecimal, type Decimal } from '@kanon/spec';
import { AutopilotMark } from '../components/autopilot';
import { Body, BrandBar, Footer, NavBar, Screen, StatusBar } from '../components/chrome';
import { FiguredText } from '../components/figured-text';
import { Enter } from '../components/motion';
import { Dot, EvidenceLink, GhostButton, Meta, Num, Panel } from '../components/ui';
import { useKanonData } from '../lib/data';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { routes, tradeRoute } from '../lib/routes';

/**
 * 00 · REFUSAL.
 *
 * Full-bleed, never a toast. It names the predicate that failed and the number
 * that failed it. Refusal is a success state: nothing here apologises, and
 * nothing here is styled as an error.
 *
 * A setup autopilot judged says so under the predicate: nobody tried to trade,
 * the rule was consulted at a candle close and held the entry.
 *
 * The verdict is the on-chain gate's: the evidence link opens its transaction,
 * and the block and bucket it judged are stated. The figures are shown only as
 * far as the chain compared them. A predicate whose window the chain could not
 * hold yet says how many samples it needs, calmly; there is no number to show.
 * A refusal from before the gate says it was decided off-chain.
 */
export function RefusalScreen() {
  const { refusal: REFUSAL, rule: RULE, latestTradeId: TRADE_ID, mode } = useKanonData();

  if (!REFUSAL) {
    return (
      <Screen rail="bg-hairline" label="00 · REFUSAL">
        <NavBar left="REFUSALS" leftHref={routes.home} right="NONE YET" />
        <Body contentClassName="justify-center">
          <Meta className="tracking-w20">NOTHING REFUSED</Meta>
          <Text className="mt-3 font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
            No setup has failed your rule.
          </Text>
          <Text className="mt-3.5 font-sans text-14 text-ash leading-[1.5]">
            When one does, this screen names the predicate and the number that decided it.
          </Text>
        </Body>
        <Footer>
          <GhostButton href={routes.home}>BACK TO RULE</GhostButton>
        </Footer>
      </Screen>
    );
  }

  // A fair value gap is decided in basis points, the others in price: write each in its own unit.
  const fmt = (d: Decimal) =>
    REFUSAL.unit === 'bps' ? formatBps(Number(d.atoms)) : formatDecimal(d);
  const { requiredHigh, currentPrice, shortfall } = REFUSAL;
  const gate = REFUSAL.gate;
  const unevaluated = gate?.unevaluated;
  // The off-chain arithmetic said otherwise a moment before. The chain's verdict stands; the difference is said.
  const offchainDiffers = gate?.offchainVerdict === 'proposed';

  return (
    <Screen rail="bg-refused" label="00 · REFUSAL">
      <StatusBar />
      <BrandBar />

      <Body>
        <Enter variant="refuse">
          <View className="mt-11 flex-row items-center gap-2.25">
            <Dot size="size-2" className="bg-refused" />
            <Text className="font-mono-bold text-11 tracking-w20 text-refused">
              {REFUSAL.label}
            </Text>
          </View>

          <Text className="mt-3.5 font-sans text-34 font-medium tracking-t25 text-bone leading-[1.06]">
            {REFUSAL.autopilot ? 'Entry blocked by your own rule.' : 'Trade blocked by your own rule.'}
          </Text>

          <View className="mt-8.5 gap-2.5 border-t border-hairline pt-3.5">
            <View className="flex-row items-baseline gap-2.5">
              <Text className="font-mono text-10 tracking-w16 text-signal">
                {RULE.ordinal}
              </Text>
              <Text className="font-mono-medium text-13 text-bone">
                {REFUSAL.predicate}
              </Text>
            </View>
            <Text className="font-mono text-13 text-ash leading-[1.5]">
              {REFUSAL.reason}
            </Text>
            {REFUSAL.autopilot ? (
              <View className="gap-1.5 pt-1">
                <AutopilotMark className="self-start" />
                <FiguredText text={REFUSAL.autopilot.line} className="font-sans text-12 leading-[18px] text-ash" />
              </View>
            ) : null}
          </View>

          {unevaluated ? (
            // Not a failing number: the chain's window is not whole yet. Stated as a count, in neutral type.
            <Panel className="mt-7.5">
              <View className="flex-row items-end justify-between gap-4.5 px-4 pt-4 pb-3.5">
                <View className="gap-1.75">
                  <Meta>SAMPLES ON CHAIN</Meta>
                  <Text className="font-mono text-10 tracking-w10 text-ash">CONSECUTIVE · {REFUSAL.actualSub}</Text>
                </View>
                <Num className="font-mono-medium text-31 tracking-t30">
                  {unevaluated.recorded} / {unevaluated.needed}
                </Num>
              </View>
            </Panel>
          ) : requiredHigh || currentPrice ? (
            <Panel className="mt-7.5">
              {requiredHigh ? (
                <View className="flex-row items-end justify-between gap-4.5 border-b border-hairline px-4 pt-4 pb-3.5">
                  <View className="gap-1.75">
                    <Meta>{REFUSAL.requiredLabel}</Meta>
                    <Text className="font-mono text-10 tracking-w10 text-ash">
                      {REFUSAL.requiredSub}
                    </Text>
                  </View>
                  <Num className="font-mono-medium text-31 tracking-t30">{fmt(requiredHigh)}</Num>
                </View>
              ) : null}
              {currentPrice ? (
                <View
                  className={cx(
                    'flex-row items-end justify-between gap-4.5 px-4 pt-4 pb-3.5',
                    shortfall && 'border-b border-hairline',
                  )}
                >
                  <View className="gap-1.75">
                    <Meta>{REFUSAL.actualLabel}</Meta>
                    <Text className="font-mono text-10 tracking-w10 text-ash">
                      {REFUSAL.actualSub}
                    </Text>
                  </View>
                  <Num className="font-mono-medium text-31 tracking-t30">{fmt(currentPrice)}</Num>
                </View>
              ) : null}
              {/* The number that failed it, given its own row and its own colour. */}
              {shortfall ? (
                <View className="flex-row items-center justify-between bg-raised px-4 py-3">
                  <Meta>SHORTFALL</Meta>
                  <View className="flex-row items-baseline gap-2.5">
                    {REFUSAL.unit === 'price' ? (
                      <Num className="text-11 text-ash">{formatBps(REFUSAL.shortfallBps)}</Num>
                    ) : null}
                    <Num className="font-mono-medium text-18 tracking-t20 text-refused">
                      {REFUSAL.unit === 'bps' ? formatBps(Number(shortfall.atoms)) : formatDecimal(shortfall)}
                    </Num>
                  </View>
                </View>
              ) : null}
            </Panel>
          ) : null}

          {offchainDiffers ? (
            <Text className="mt-3 font-mono text-10 tracking-w06 text-ash leading-[1.5]">
              Kanon&apos;s off-chain check would have passed it. The chain&apos;s verdict is the one that stands.
            </Text>
          ) : null}

          <View className="mt-4.5 flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <Num className="text-10 tracking-w08 text-ash">{REFUSAL.at}</Num>
            <Num className="text-10 tracking-w08 text-ash">
              {mode === 'demo' ? `BLOCK ${REFUSAL.block}` : REFUSAL.block}
            </Num>
          </View>
          {/* The outcomes and the candles they were read from: the rest of the evidence, in the app. */}
          {mode === 'live' ? (
            <Link
              href={tradeRoute(REFUSAL.tradeId || TRADE_ID)}
              aria-label="The evidence chain: each predicate, the number it was decided on, and its candle"
              className="mt-3.5 mb-5 flex-row items-center justify-between border-y border-hairline py-3 active:opacity-60"
            >
              <Text className="font-mono text-11 tracking-w06 text-bone">EVIDENCE CHAIN</Text>
              <Text className="font-mono text-10 tracking-w06 text-verified">PREDICATES · CANDLES ›</Text>
            </Link>
          ) : (
            <View className="mb-5" />
          )}
        </Enter>
      </Body>

      <Footer>
        {gate ? (
          // The gate's own transaction: the verdict, where anyone can read it.
          <EvidenceLink
            className="mb-4.5"
            label="View the gate transaction"
            hash={gate.tx.short}
            href={gate.tx.url}
          />
        ) : REFUSAL.decided === 'offchain' ? (
          // Decided before the gate: there is no transaction to show, and the link does not pretend otherwise.
          <EvidenceLink
            className="mb-4.5"
            label="View the evidence"
            hash="OFF-CHAIN"
            href={tradeRoute(REFUSAL.tradeId || TRADE_ID)}
          />
        ) : (
          <EvidenceLink
            className="mb-4.5"
            label="View on-chain evidence"
            hash={RULE.txAbbrev}
            href={tradeRoute(REFUSAL.tradeId || TRADE_ID)}
          />
        )}
        <GhostButton href={routes.home}>ACKNOWLEDGE</GhostButton>
      </Footer>
    </Screen>
  );
}
