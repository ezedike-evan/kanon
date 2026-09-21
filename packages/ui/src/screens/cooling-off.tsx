import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { COOLING_OFF_SECONDS, diffSpec } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { CoolingOffCountdown } from '../components/countdown';
import { GhostButton, Meta, Num, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { CHANGE_TAG, formatChangeValue } from '../lib/change-format';
import { useKanonData } from '../lib/data';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

/** True once the wall clock has passed `endsAt`. Read off the timestamp, never counted down. */
function useElapsed(endsAt: number | undefined): boolean {
  const [elapsed, setElapsed] = useState(() => endsAt !== undefined && Date.now() >= endsAt);
  useEffect(() => {
    if (endsAt === undefined) return;
    const read = () => setElapsed(Date.now() >= endsAt);
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [endsAt]);
  return elapsed;
}

/**
 * 08 · COOLING-OFF.
 *
 * Tightening a rule is immediate. Loosening one waits, with a visible,
 * unskippable countdown. The friction is the product, so it is rendered rather
 * than hidden — and the old parameters stay enforced the whole time.
 *
 * The change can be applied only once the hold has run: the button does not
 * exist before that, and the server refuses it a millisecond early as well.
 */
export function CoolingOffScreen() {
  const nav = useNavigator();
  const { coolingOff: COOLING_OFF, rule: RULE, finalizeCoolingOff, withdrawCoolingOff } = useKanonData();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const elapsed = useElapsed(COOLING_OFF?.endsAt);

  if (!COOLING_OFF) {
    return (
      <Screen label="08 · COOLING-OFF">
        <NavBar left="COOLING OFF" leftClassName="text-signal" leftHref={routes.home} right={RULE.ordinal} />
        <Body contentClassName="justify-center">
          <Meta className="tracking-w20">NOTHING PENDING</Meta>
          <Text className="mt-3 font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
            No change is waiting to apply.
          </Text>
          <View className="mt-6 gap-2.5 border-t border-hairline pt-4">
            <View className="flex-row justify-between">
              <Text className="font-mono text-11p5 text-ash">TIGHTENING A RULE</Text>
              <Text className="font-mono text-11p5 text-bone">IMMEDIATE</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="font-mono text-11p5 text-ash">LOOSENING A RULE</Text>
              <Num className="text-11p5 text-signal">{Math.round(COOLING_OFF_SECONDS / 3600)} HOUR HOLD</Num>
            </View>
          </View>
        </Body>
        <Footer>
          <GhostButton href={routes.home}>BACK TO RULE</GhostButton>
        </Footer>
      </Screen>
    );
  }

  const hold = COOLING_OFF.holdSeconds ?? COOLING_OFF_SECONDS;
  // The classification comes from @kanon/spec, not from this screen: the same
  // function decides what the contract will accept immediately and what waits.
  const diff = diffSpec(COOLING_OFF.currentSpec, COOLING_OFF.pendingSpec);
  const canApply = COOLING_OFF.endsAt !== undefined && elapsed;

  async function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const out = await action();
    setBusy(false);
    if (out.ok) nav.replace(routes.home);
    else setNote(out.message ?? 'That could not be done yet.');
  }

  return (
    <Screen label="08 · COOLING-OFF">
      <NavBar
        left="COOLING OFF"
        leftClassName="text-signal"
        leftHref={routes.home}
        right={RULE.ordinal}
      />

      <Body>
        <Meta className="mt-11 tracking-w20">
          {canApply ? 'HOLD COMPLETE' : 'CHANGE APPLIES IN'}
        </Meta>
        <CoolingOffCountdown
          requestedAt={COOLING_OFF.requestedAt}
          holdSeconds={hold}
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
              <View className="flex-1 gap-1">
                <Text className="font-mono text-12 text-ash">{change.path}</Text>
                <Text className="font-mono text-9 tracking-w14 text-ash">{CHANGE_TAG[change.kind]}</Text>
              </View>
              <View className="flex-row items-baseline gap-3">
                <Num className="text-15 text-ash line-through">
                  {formatChangeValue(change.path, change.before)}
                </Num>
                <Text className="font-mono text-11 text-ash" aria-hidden>
                  →
                </Text>
                <Num className="font-mono-medium text-18 text-signal">
                  {formatChangeValue(change.path, change.after)}
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
            <Num className="text-11p5 text-signal">{Math.round(hold / 3600)} HOUR HOLD</Num>
          </View>
        </View>
        <Text className="mt-3.5 mb-5 font-sans text-13p5 text-ash leading-[1.5]">
          Until then the old parameters stay enforced. Nothing about your current
          rule changes while you wait.
        </Text>
      </Body>

      <Footer className="gap-2.5">
        {note ? <Text className="mb-1 font-mono text-11 text-signal leading-[1.5]">{note}</Text> : null}
        {canApply ? (
          <PrimaryButton disabled={busy} onPress={() => run(finalizeCoolingOff)}>
            {busy ? 'APPLYING' : 'APPLY CHANGE'}
          </PrimaryButton>
        ) : null}
        <GhostButton disabled={busy} onPress={() => run(withdrawCoolingOff)}>
          WITHDRAW CHANGE
        </GhostButton>
      </Footer>
    </Screen>
  );
}
