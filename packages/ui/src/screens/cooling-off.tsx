import { Text, View } from 'react-native';
import { COOLING_OFF_SECONDS, diffSpec, formatBps } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { CoolingOffCountdown } from '../components/countdown';
import { GhostButton, Meta, Num } from '../components/ui';
import { COOLING_OFF, PENDING_SPEC, RULE, SPEC } from '../lib/demo';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

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
export function CoolingOffScreen() {
  // The classification comes from @kanon/spec, not from this screen: the same
  // function decides what the contract will accept immediately and what waits.
  const diff = diffSpec(SPEC, PENDING_SPEC);

  return (
    <Screen label="08 · COOLING-OFF">
      <NavBar
        left="COOLING OFF"
        leftClassName="text-signal"
        leftHref={routes.home}
        right={RULE.ordinal}
      />

      <Body>
        <Meta className="mt-11 tracking-w20">CHANGE APPLIES IN</Meta>
        <CoolingOffCountdown
          requestedAt={COOLING_OFF.requestedAt}
          holdSeconds={COOLING_OFF_SECONDS}
          nowAt={COOLING_OFF.nowAt}
        />
        <Text className="mt-3 font-mono text-10 tracking-w08 text-ash">
          {COOLING_OFF.requestedLabel}
        </Text>

        <Text className="mt-10 font-sans text-26 font-medium tracking-t20 text-bone leading-[1.14]">
          You are loosening a rule you pinned.
        </Text>

        <View className="mt-6.5 border border-hairline bg-panel">
          <View className="border-b border-hairline px-3.5 py-3">
            <Meta>PENDING DIFF</Meta>
          </View>
          {diff.changes.map((change, i) => (
            <View
              key={change.path}
              className={cx(
                'flex-row items-center justify-between gap-3 px-3.5 py-3.25',
                i < diff.changes.length - 1 && 'border-b border-hairline',
              )}
            >
              <Text className="font-mono text-12 text-ash">
                {LABEL[change.path] ?? change.path}
              </Text>
              <View className="flex-row items-baseline gap-3">
                <Num className="text-15 text-ash line-through">
                  {formatBps(Number(change.before))}
                </Num>
                <Text className="font-mono text-11 text-ash" aria-hidden>
                  →
                </Text>
                <Num className="font-mono-medium text-18 text-signal">
                  {formatBps(Number(change.after))}
                </Num>
              </View>
            </View>
          ))}
        </View>

        <View className="mt-5.5 gap-2.5 border-t border-hairline pt-4">
          <View className="flex-row justify-between">
            <Text className="font-mono text-11p5 text-ash">TIGHTENING A RULE</Text>
            <Text className="font-mono text-11p5 text-bone">IMMEDIATE</Text>
          </View>
          <View className="flex-row justify-between">
            <Text className="font-mono text-11p5 text-ash">LOOSENING A RULE</Text>
            <Num className="text-11p5 text-signal">24 HOUR HOLD</Num>
          </View>
        </View>
        <Text className="mt-3.5 mb-5 font-sans text-13p5 text-ash leading-[1.5]">
          Until then the old parameters stay enforced. Nothing about your current
          rule changes while you wait.
        </Text>
      </Body>

      <Footer>
        <GhostButton href={routes.home}>WITHDRAW CHANGE</GhostButton>
      </Footer>
    </Screen>
  );
}
