import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatDecimal } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { Dot, Meta, Num, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { usePlatform } from '../platform';
import { PINNING, RULE } from '../lib/demo';
import { routes } from '../lib/routes';

/**
 * 04 · PINNING CEREMONY.
 *
 * Deliberately weighted. The hash, the bond and the three things you are
 * agreeing to, then a biometric signature. There is no admin key and no support
 * path behind this screen: what you agree to here is what gets enforced.
 */
export function PinningScreen() {
  const nav = useNavigator();
  const { authenticate, hasBiometrics } = usePlatform();
  const [signing, setSigning] = useState(false);

  async function sign() {
    if (signing) return;
    setSigning(true);
    try {
      // No passkey, no pin. A ceremony that claims a signature it did not take
      // would be the exact lie the rest of the product exists to prevent.
      const ok = hasBiometrics ? await authenticate('Sign and pin this rule') : true;
      if (ok) nav.replace(routes.home);
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
            <Num className="flex-1 text-right text-12">{RULE.specHash}</Num>
          </View>
          <View className="flex-row items-baseline justify-between border-b border-hairline py-3.5">
            <Meta>CONTRACT</Meta>
            <Num className="text-12">{RULE.contract}</Num>
          </View>
          <View className="flex-row items-end justify-between border-b border-hairline py-4">
            <View className="gap-1.75">
              <Meta>BOND POSTED</Meta>
              <Text className="font-mono text-10 tracking-w10 text-ash">
                RETURNED ON UNPIN
              </Text>
            </View>
            <Num className="font-mono-medium text-31 tracking-t30 text-signal">
              {formatDecimal(PINNING.bond)}
              <Text className="font-mono text-15 tracking-w04 text-signal">
                {` ${PINNING.bondUnit}`}
              </Text>
            </Num>
          </View>
        </View>

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
              This device has no passkey. Pinning for real happens on the phone.
            </Text>
          </View>
        )}
        <PrimaryButton onPress={sign} disabled={signing} className="py-5" textClassName="tracking-w20">
          HOLD TO SIGN
        </PrimaryButton>
      </Footer>
    </Screen>
  );
}
