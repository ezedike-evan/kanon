import { Fragment, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { Dot, Num, PrimaryButton } from '../components/ui';
import { REVIEW } from '../lib/demo';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

type View_ = 'plain' | 'parametric';

/**
 * 03 · SPEC REVIEW.
 *
 * Compilation is always reviewed, never silent. Two registers: plain English by
 * default, parametric one toggle away. Every default the compiler chose is
 * listed by name — a user who discovers an unseen parameter later is a
 * permanent loss of trust, so there is nowhere for one to hide.
 */
export function SpecReviewScreen() {
  const [view, setView] = useState<View_>('plain');

  return (
    <Screen label="03 · SPEC REVIEW">
      <NavBar left="REVIEW SPEC" right="CLOSE ✕" />

      <View className="mx-5 mt-5 shrink-0 flex-row overflow-hidden rounded-[2px] border border-hairline">
        {(['plain', 'parametric'] as const).map((key) => (
          <Pressable
            key={key}
            onPress={() => setView(key)}
            role="button"
            aria-pressed={view === key}
            className={cx('flex-1 items-center py-2.75', view === key && 'bg-raised')}
          >
            <Text
              className={cx(
                'font-mono text-11 tracking-w12',
                view === key ? 'text-bone' : 'text-ash',
              )}
            >
              {key === 'plain' ? 'PLAIN ENGLISH' : 'PARAMETRIC'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Body contentClassName="pt-6.5">
        {view === 'plain' ? (
          <View className="gap-5.5">
            {REVIEW.plain.map((segments, i) => (
              <Fragment key={i}>
                {i > 0 ? <View className="h-px bg-hairline" /> : null}
                <View className="gap-2.5">
                  <Text className="font-mono text-9 tracking-w20 text-ash">
                    PREDICATE {String(i + 1).padStart(2, '0')}
                  </Text>
                  <Text className="font-sans text-15 text-bone leading-[1.6]">
                    {segments.map((segment, j) =>
                      typeof segment === 'string' ? (
                        <Text key={j}>{segment}</Text>
                      ) : (
                        /* Bound parameters are editable in place. No hidden defaults. */
                        <Text
                          key={j}
                          className="font-mono text-13 text-signal underline decoration-signal"
                          role="button"
                        >
                          {segment.param}
                        </Text>
                      ),
                    )}
                  </Text>
                </View>
              </Fragment>
            ))}
          </View>
        ) : (
          <View>
            {REVIEW.parametric.map((line, i) => (
              <View key={line} className="flex-row gap-3">
                <Num className="w-4 text-12 text-hairline leading-[1.85]">
                  {String(i + 1).padStart(2, '0')}
                </Num>
                <Text className="flex-1 font-mono text-12 text-ash leading-[1.85]">
                  {line}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Surfaced in both registers: an inferred default is never silent. */}
        <View className="mt-5 mb-5 border border-inferred-edge bg-inferred-wash p-3.5">
          <View className="flex-row items-center gap-2.25">
            <Dot className="bg-signal" />
            <Text className="font-mono text-9 tracking-w18 text-signal">
              {REVIEW.inferred.length} DEFAULTS INFERRED
            </Text>
          </View>
          <View className="mt-2.75 gap-1.75">
            {REVIEW.inferred.map((d) => (
              <View key={d.name} className="flex-row justify-between gap-3">
                <Text className="font-mono text-11p5 text-ash leading-[1.5]">
                  {d.name}
                </Text>
                <Text className="font-mono text-11p5 text-ash leading-[1.5]">
                  <Num className="text-11p5 text-bone">{d.value}</Num>
                  {'   — not stated'}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </Body>

      <Footer className="border-t border-hairline pt-5">
        <View className="mb-4 flex-row items-center justify-between">
          <Text className="font-mono text-10 tracking-w10 text-ash">ENFORCEMENT</Text>
          <Text className="font-mono text-10 tracking-w10 text-bone">
            IMMEDIATE ON PIN
          </Text>
        </View>
        <PrimaryButton href={routes.compilePin}>PIN ON-CHAIN</PrimaryButton>
      </Footer>
    </Screen>
  );
}
