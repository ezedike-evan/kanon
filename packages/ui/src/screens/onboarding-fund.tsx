import { Pressable, Text, View } from 'react-native';
import { OnboardingScreen } from '../components/onboarding';
import { GhostButton, Num } from '../components/ui';
import { ONBOARDING } from '../lib/demo';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

/**
 * 10B · ONBOARDING · FUND.
 *
 * Paper mode is offered as a first-class option, not a demo mode: the rule is
 * enforced either way, and enforcement is what the product is.
 */
export function OnboardingFundScreen() {
  return (
    <OnboardingScreen
      step={2}
      label="10B · ONBOARDING · FUND"
      title="Give the rule something to enforce."
      blurb="Connect an exchange account or fund the Kanon wallet directly. You can change this later."
      footer={<GhostButton href={routes.onboardingStrategy}>SKIP FOR NOW</GhostButton>}
    >
      <View className="mt-8.5">
        {ONBOARDING.fund.map((option, i) => (
          <Pressable
            key={option.title}
            role="button"
            className={cx(
              'flex-row items-center justify-between gap-3 border-t border-hairline py-4.25',
              i === ONBOARDING.fund.length - 1 && 'border-b',
            )}
          >
            <View className="gap-1.75">
              <Text
                className={cx(
                  'font-mono-medium text-13',
                  option.muted ? 'text-ash' : 'text-bone',
                )}
              >
                {option.title}
              </Text>
              <Num className="text-10p5 text-ash">{option.sub}</Num>
            </View>
            <Text className="font-mono text-12 text-ash" aria-hidden>
              →
            </Text>
          </Pressable>
        ))}
      </View>
    </OnboardingScreen>
  );
}
