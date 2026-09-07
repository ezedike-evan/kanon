import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Screen, Footer } from './chrome';

/**
 * Three onboarding screens, one shape: a headline that arrives low on the
 * screen, a sentence under it, the choice, and a bottom-anchored action.
 * Everything is reachable with one thumb.
 */
export function OnboardingScreen({
  step,
  label,
  title,
  blurb,
  children,
  footer,
}: {
  step: 1 | 2 | 3;
  label: string;
  title: string;
  blurb: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Screen label={label}>
      <View className="shrink-0 flex-row items-center justify-between px-5 pt-5.5">
        <Text className="font-mono-bold text-12 tracking-w22 text-bone">KANON</Text>
        <Text className="font-mono text-10 tracking-w14 text-ash">
          {String(step).padStart(2, '0')} / 03
        </Text>
      </View>

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="grow justify-end px-5 pb-2.5"
        showsVerticalScrollIndicator={false}
      >
        <Text className="font-sans text-32 font-medium tracking-t25 text-bone leading-[1.1]">
          {title}
        </Text>
        <Text className="mt-4.5 font-sans text-15 text-ash leading-[1.55]">{blurb}</Text>
        {children}
      </ScrollView>

      <Footer className="pt-6">{footer}</Footer>
    </Screen>
  );
}
