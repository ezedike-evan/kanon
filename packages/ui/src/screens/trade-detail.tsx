import { Text, View } from 'react-native';
import { formatBps, formatDecimal } from '@kanon/spec';
import { AutopilotBlock } from '../components/autopilot';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { EvidenceChain } from '../components/evidence-chain';
import { EvidenceLink, Meta, Num } from '../components/ui';
import { useKanonData } from '../lib/data';
import { routes, shareRoute } from '../lib/routes';

/**
 * 06 · TRADE DETAIL · EVIDENCE.
 *
 * The result is stated once and the evidence chain gets the rest of the screen.
 * If verification took more than one tap, "verifiable" would be marketing and
 * this audience would treat it as marketing.
 *
 * A setup autopilot judged carries that above its evidence: where it stands
 * with the venue, what was asked for, the timed trade that was opened for it
 * (one press, and where the real fill is), or the reason nothing was.
 *
 * The chain's first claim is the on-chain gate's: its verdict, transaction,
 * block, bucket and signer, and whether the off-chain check agreed. The footer
 * opens that transaction. A row from before the gate says it was decided
 * off-chain, and its footer keeps the pinned rule's own proof.
 */
export function TradeDetailScreen({ id }: { id: string }) {
  const { rule: RULE, tradeDetail } = useKanonData();
  const TRADE = tradeDetail(id);

  if (!TRADE) {
    return (
      <Screen rail="bg-hairline" label="06 · TRADE DETAIL · EVIDENCE">
        <NavBar left="←  TRADES" leftHref={routes.blocked} leftClassName="text-ash tracking-w12" />
        <Body contentClassName="justify-center">
          <Meta className="tracking-w20">NO SUCH TRADE</Meta>
          <Text className="mt-3 font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
            This trade is not on your rule.
          </Text>
          <Text className="mt-3.5 font-sans text-14 text-ash leading-[1.5]">
            It may belong to another strategy, or it may not have loaded yet.
          </Text>
        </Body>
        <Footer>
          <EvidenceLink label="Blocked trades" hash="" href={routes.blocked} />
        </Footer>
      </Screen>
    );
  }

  const refused = TRADE.side.includes('REFUSED');
  // Waiting, or nothing opened: a state, set in the neutral colour. Never an alarm.
  const neutral = TRADE.autopilot?.state === 'waiting' || TRADE.autopilot?.state === 'not_opened';
  return (
    <Screen rail="bg-hairline" label="06 · TRADE DETAIL · EVIDENCE">
      <NavBar
        left="←  TRADES"
        leftHref={routes.blocked}
        leftClassName="text-ash tracking-w12"
        right={`TRADE ${id.toUpperCase()}`}
      />

      <Body>
        <View className="mt-6.5 flex-row items-end justify-between">
          <View className="gap-2.25">
            <Text
              className={
                refused
                  ? 'font-mono text-11 tracking-w14 text-refused'
                  : neutral
                    ? 'font-mono text-11 tracking-w14 text-ash'
                    : 'font-mono text-11 tracking-w14 text-long'
              }
            >
              {TRADE.side}
            </Text>
            <Num className="font-mono-medium text-20 tracking-t20">{RULE.asset}</Num>
          </View>
          <View className="items-end gap-1.75">
            <Meta>RESULT</Meta>
            {/* No result exists until the trade has closed. A dash, never an estimate. */}
            <Num
              className={
                TRADE.result
                  ? 'font-mono-medium text-31 tracking-t30 text-long leading-[0.9]'
                  : 'font-mono-medium text-31 tracking-t30 text-ash leading-[0.9]'
              }
            >
              {TRADE.result ? formatDecimal(TRADE.result, { signed: true }) : '—'}
            </Num>
          </View>
        </View>

        <View className="mt-5.5 flex-row border-y border-hairline">
          <View className="flex-1 gap-1.75 py-3.25">
            <Meta>ENTRY</Meta>
            <Num className="font-mono-medium text-15">{formatDecimal(TRADE.entry)}</Num>
          </View>
          <View className="flex-1 gap-1.75 py-3.25">
            <Meta>EXIT</Meta>
            <Num className="font-mono-medium text-15">
              {TRADE.exit ? formatDecimal(TRADE.exit) : '—'}
            </Num>
          </View>
          <View className="flex-1 items-end gap-1.75 py-3.25">
            <Meta>RETURN</Meta>
            <Num
              className={
                TRADE.returnBps !== null
                  ? 'font-mono-medium text-15 text-long'
                  : 'font-mono-medium text-15 text-ash'
              }
            >
              {TRADE.returnBps !== null ? formatBps(TRADE.returnBps, { signed: true }) : '—'}
            </Num>
          </View>
        </View>

        {TRADE.autopilot ? <AutopilotBlock note={TRADE.autopilot} className="mt-5" /> : null}

        <Meta className="mt-6.5 tracking-w20">
          EVIDENCE CHAIN · {TRADE.claims.length} CLAIMS
        </Meta>
        <EvidenceChain claims={TRADE.claims} />
        <View className="pb-5" />
      </Body>

      <Footer>
        {TRADE.gateTx ? (
          <EvidenceLink
            label="View the gate transaction"
            hash={TRADE.gateTx.short}
            href={TRADE.gateTx.url}
          />
        ) : (
          <EvidenceLink label="Verify on-chain" hash={RULE.txAbbrev} href={shareRoute(RULE.id)} />
        )}
      </Footer>
    </Screen>
  );
}
