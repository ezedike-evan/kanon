import { Text, View } from 'react-native';
import { OnboardingScreen } from '../components/onboarding';
import { PrimaryButton } from '../components/ui';
import { routes } from '../lib/routes';

/**
 * 10A · ONBOARDING · PASSKEY.
 *
 * A passkey, not a seed phrase. Kanon never holds a key and cannot move funds —
 * stated here because it is the first thing this audience will want to know.
 */
export function OnboardingPasskeyScreen() {
  return (
    <OnboardingScreen
      step={1}
      label="10A · ONBOARDING · PASSKEY"
      title="Sign in with your face. No seed phrase."
      blurb="Your account is a passkey held by this device. Kanon never sees a key and cannot move your funds."
      footer={<PrimaryButton href={routes.onboardingFund}>CONTINUE</PrimaryButton>}
    >
      <View className="mt-8.5 flex-row items-center gap-3.5 border-y border-hairline py-4.5">
        <View className="size-9.5 shrink-0 items-center justify-center rounded-full border border-signal">
          <View className="size-3 rounded-full border border-signal" />
        </View>
        <View className="gap-1.25">
          <Text className="font-mono text-11 tracking-w10 text-bone">FACE ID</Text>
          <Text className="font-mono text-10 text-ash">
            Creates your passkey on this device
          </Text>
        </View>
      </View>
    </OnboardingScreen>
  );
}
