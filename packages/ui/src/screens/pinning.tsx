import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatDecimal } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { Dot, Meta, Num, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { usePlatform } from '../platform';
import { useKanonData } from '../lib/data';
import { routes } from '../lib/routes';

/**
 * 04 · PINNING CEREMONY.
 *
 * Deliberately weighted. The hash, the bond and the three things you are
 * agreeing to, then a biometric signature. There is no admin key and no support
 * path behind this screen: what you agree to here is what gets enforced.
 *
 * A pin is reported only when the registry accepted it. Where pinning cannot
 * happen (no registry deployed on this network, no wallet to sign with) the
 * ceremony says so and the sign button stays off: a ceremony that claimed a
 * signature it did not take would be the lie the rest of the product exists to
 * prevent.
 */
export function PinningScreen() {
  const nav = useNavigator();
  const { authenticate, hasBiometrics } = usePlatform();
  const { pinning: PINNING, pinStrategy, mode } = useKanonData();
  const [signing, setSigning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const availability = PINNING.availability;
  const blocked = availability.state !== 'ready' && availability.state !== 'demo';
  const busy = signing || PINNING.busy;
  const noBond = PINNING.bond.atoms === '0';

  async function sign() {
    if (busy || blocked) return;
    setSigning(true);
    setMessage(null);
    try {
      // No passkey, no pin, where a passkey exists. On a browser the embedded
      // wallet's own signature is the signature.
      const ok = hasBiometrics ? await authenticate('Sign and pin this rule') : true;
      if (!ok) {
        setMessage('The passkey check did not pass. Nothing was pinned.');
        return;
      }
      const outcome = await pinStrategy();
      if (outcome.ok) nav.replace(routes.home);
      else setMessage(outcome.message);
    } finally {
      setSigning(false);
    }
  }

  return (
    <Screen label="04 · PINNING CEREMONY">
      <NavBar
        left="PINNING"
        leftClassName="text-signal"
        leftHref={routes.compileReview}
        right={PINNING.step}
      />

      <Body>
        <Text className="mt-10 font-sans text-30 font-medium tracking-t25 text-bone leading-[1.1]">
          You are writing this rule into a contract.
        </Text>

        <View className="mt-7.5 border-t border-hairline">
          <View className="flex-row items-baseline justify-between gap-4 border-b border-hairline py-3.5">
            <Meta className="shrink-0">SPEC HASH</Meta>
            <Num className="flex-1 text-right text-12">{PINNING.specHash || '—'}</Num>
          </View>
          <View className="flex-row items-baseline justify-between border-b border-hairline py-3.5">
            <Meta>CONTRACT</Meta>
            <Num className={blocked ? 'text-12 text-signal' : 'text-12'}>{PINNING.contract}</Num>
          </View>
          {/* What the gate is given next to the hash: the predicates it will check, and the tape it reads. */}
          {PINNING.commitment !== undefined ? (
            <>
              <View className="flex-row items-baseline justify-between gap-4 border-b border-hairline py-3.5">
                <Meta className="shrink-0">PREDICATES</Meta>
                <Num className="flex-1 text-right text-12">{PINNING.commitment || '—'}</Num>
              </View>
              <View className="flex-row items-baseline justify-between border-b border-hairline py-3.5">
                <Meta>SERIES</Meta>
                <Num className={PINNING.series === 'NOT DEPLOYED' ? 'text-12 text-signal' : 'text-12'}>
                  {PINNING.series}
                </Num>
              </View>
            </>
          ) : null}
          <View className="flex-row items-end justify-between border-b border-hairline py-4">
            <View className="gap-1.75">
              <Meta>BOND POSTED</Meta>
              <Text className="font-mono text-10 tracking-w10 text-ash">
                {mode === 'live' ? "THE REGISTRY'S MINIMUM" : 'RETURNED ON UNPIN'}
              </Text>
            </View>
            <Num className="font-mono-medium text-31 tracking-t30 text-signal">
              {noBond ? '—' : formatDecimal(PINNING.bond)}
              <Text className="font-mono text-15 tracking-w04 text-signal">
                {` ${PINNING.bondUnit}`}
              </Text>
            </Num>
          </View>
        </View>

        {availability.state === 'ready' ? null : (
          <View
            className="mt-6 gap-2 border border-hairline bg-panel p-3.5"
            role={blocked ? 'alert' : undefined}
          >
            <View className="flex-row items-center gap-2.25">
              <Dot className={blocked ? 'bg-signal' : 'bg-ash'} />
              <Text
                className={
                  blocked
                    ? 'font-mono text-9 tracking-w18 text-signal'
                    : 'font-mono text-9 tracking-w18 text-ash'
                }
              >
                {availability.state === 'not_deployed'
                  ? 'NOT DEPLOYED'
                  : availability.state === 'no_wallet'
                    ? 'NO WALLET'
                    : 'DEMO'}
              </Text>
            </View>
            <Text className="font-sans text-13 text-ash leading-[1.5]">{availability.message}</Text>
          </View>
        )}

        <View className="mt-6.5 mb-5 gap-3">
          <Text className="font-mono text-9 tracking-w20 text-ash">
            YOU ARE AGREEING THAT
          </Text>
          {PINNING.agreements.map((line) => (
            <View key={line} className="flex-row gap-2.75">
              <Dot className="mt-1.75 bg-signal" />
              <Text className="flex-1 font-sans text-14p5 text-bone leading-[1.5]">
                {line}
              </Text>
            </View>
          ))}
        </View>
      </Body>

      <Footer>
        {hasBiometrics ? (
          <View className="mb-4.5 flex-row items-center gap-3.5 border-t border-hairline py-4">
            <View className="size-9.5 shrink-0 items-center justify-center rounded-full border border-signal">
              <View className="size-3 rounded-full border border-signal" />
            </View>
            <View className="gap-1.25">
              <Text className="font-mono text-11 tracking-w10 text-bone">
                FACE ID REQUIRED
              </Text>
              <Text className="font-mono text-10 tracking-w06 text-ash">
                Signs with your device passkey
              </Text>
            </View>
          </View>
        ) : (
          <View className="mb-4.5 border-t border-hairline py-4">
            <Text className="font-mono text-10 tracking-w06 text-ash leading-[1.5]">
              {mode === 'live'
                ? 'Your embedded wallet signs the pin. It is a real transaction, and the bond leaves your balance.'
                : 'This device has no passkey. Pinning for real happens on the phone.'}
            </Text>
          </View>
        )}
        {message ? (
          <Text className="mb-3.5 font-mono text-11 text-signal leading-[1.5]" role="alert">
            {message}
          </Text>
        ) : null}
        <PrimaryButton
          onPress={sign}
          disabled={busy || blocked}
          className="py-5"
          textClassName="tracking-w20"
        >
          {busy ? 'SIGNING' : 'HOLD TO SIGN'}
        </PrimaryButton>
      </Footer>
    </Screen>
  );
}
