import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { OnboardingScreen } from '../components/onboarding';
import { Num, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { useTheme } from '../theme';
import { useKanonData } from '../lib/data';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

const LIMIT = 400;

/**
 * 10C · ONBOARDING · FIRST STRATEGY.
 *
 * Onboarding ends in a text field, on purpose. The first thing the product asks
 * for is the rule you keep breaking, in your own words — the compiler's job is
 * to translate it, not to improve it.
 */
export function OnboardingStrategyScreen() {
  const { colors } = useTheme();
  const nav = useNavigator();
  const { onboardingStrategy, sendCompilerMessage, mode } = useKanonData();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  return (
    <OnboardingScreen
      step={3}
      label="10C · ONBOARDING · FIRST STRATEGY"
      title="Describe the rule you keep breaking."
      blurb="Write it the way you'd say it out loud. Kanon compiles it into something a contract can check."
      footer={
        <PrimaryButton
          disabled={mode === 'live' && text.trim().length === 0}
          onPress={() => {
            // The compile starts here and finishes on the compiler screen, which shows it working.
            void sendCompilerMessage(text);
            nav.push(routes.compile);
          }}
        >
          COMPILE
        </PrimaryButton>
      }
    >
      <View
        className={cx(
          'mt-7.5 min-h-29.5 justify-between gap-3 border bg-panel p-3.75',
          focused ? 'border-signal' : 'border-hairline',
        )}
      >
        <TextInput
          value={text}
          onChangeText={(next) => setText(next.slice(0, LIMIT))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          multiline
          numberOfLines={3}
          placeholder="Only take longs after a sweep of the previous day's low"
          placeholderTextColor={colors.ash}
          cursorColor={colors.signal}
          selectionColor={colors.signal}
          aria-label="Your rule, in plain English"
          className="font-mono text-13p5 text-bone leading-[1.55]"
          style={{ textAlignVertical: 'top' }}
        />
        <View className="flex-row items-center justify-between">
          <Text className="font-mono text-9 tracking-w16 text-ash">PLAIN ENGLISH</Text>
          <Num className="text-9 tracking-w16 text-ash">
            {text.length} / {LIMIT}
          </Num>
        </View>
      </View>

      <View className="mt-4 gap-2.5">
        <Text className="font-mono text-9 tracking-w20 text-ash">OR START FROM</Text>
        <View className="flex-row flex-wrap gap-2">
          {onboardingStrategy.starters.map((starter) => (
            <Pressable
              key={starter}
              role="button"
              onPress={() => setText(starter)}
              className="rounded-[2px] border border-hairline px-2.5 py-2"
            >
              <Text className="font-mono text-11 text-ash">{starter}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </OnboardingScreen>
  );
}
