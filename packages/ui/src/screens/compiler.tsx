import { ScrollView, Text, View } from 'react-native';
import { Footer, Screen, StatusBar } from '../components/chrome';
import { Enter } from '../components/motion';
import { Dot, Num, PrimaryButton } from '../components/ui';
import { COMPILER } from '../lib/demo';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

/**
 * 02 · CHAT-TO-SPEC COMPILER.
 *
 * Chat above, live spec diff below. The model's job here is translation, not
 * prediction — you watch your own language turn into an object a dumb machine
 * can check, and nothing is pinned until you have reviewed it.
 */
export function CompilerScreen() {
  const changed = COMPILER.lines.filter((l) => l.changed).length;

  return (
    <Screen label="02 · CHAT-TO-SPEC COMPILER">
      <StatusBar />
      <View className="shrink-0 flex-row items-center justify-between border-b border-hairline px-5 pt-5 pb-4">
        <Text className="font-mono text-11 tracking-w16 text-bone">COMPILER</Text>
        <Text className="font-mono text-10 tracking-w12 text-ash">{COMPILER.draft}</Text>
      </View>

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="grow gap-5 p-5"
        showsVerticalScrollIndicator={false}
      >
        {COMPILER.transcript.map((turn, i) => {
          const mine = turn.from === 'YOU';
          return (
            <View key={i} className={cx('gap-2', mine && 'items-end')}>
              <Text className="font-mono text-9 tracking-w20 text-ash">
                {turn.from} · {turn.at}
              </Text>
              <View
                className={cx(
                  mine && 'border border-hairline bg-raised px-3.5 py-3.25',
                )}
              >
                <Text
                  className={cx(
                    'font-sans text-14 leading-[1.5]',
                    mine ? 'text-bone' : 'text-ash',
                  )}
                >
                  {turn.text}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      {/* The spec, live. Changed lines fade up in `signal` and settle. */}
      <View className="shrink-0 border-t border-hairline bg-sunken">
        <View className="flex-row items-center justify-between px-5 pt-3.5 pb-2.5">
          <Text className="font-mono text-9 tracking-w20 text-ash">COMPILED SPEC</Text>
          <Text className="font-mono text-9 tracking-w16 text-signal">
            +{changed} CHANGED
          </Text>
        </View>
        <View className="px-5 pb-4">
          {COMPILER.lines.map((line, i) => {
            const row = (
              <View
                className={cx(
                  'flex-row gap-3',
                  line.changed && 'bg-diff-wash',
                )}
              >
                <Num
                  className={cx(
                    'w-4 text-12 leading-[1.85]',
                    line.changed ? 'text-diff-gutter' : 'text-hairline',
                  )}
                >
                  {String(i + 1).padStart(2, '0')}
                </Num>
                <Text
                  className={cx(
                    'flex-1 font-mono text-12 leading-[1.85]',
                    line.changed ? 'text-signal' : 'text-ash',
                  )}
                >
                  {line.text}
                </Text>
              </View>
            );
            return line.changed ? (
              <Enter key={line.text} variant="diff">
                {row}
              </Enter>
            ) : (
              <View key={line.text}>{row}</View>
            );
          })}
        </View>
        <Footer className="flex-row items-center justify-between border-t border-hairline bg-panel px-5 pt-3">
          <View className="flex-row items-center gap-2.25">
            <Dot className="bg-signal" />
            <Text className="font-mono text-11 tracking-w08 text-ash">
              {changed} UNSAVED CHANGES
            </Text>
          </View>
          <PrimaryButton
            href={routes.compileReview}
            className="w-auto px-4 py-3"
            textClassName="text-11 tracking-w14"
          >
            REVIEW &amp; PIN
          </PrimaryButton>
        </Footer>
      </View>
    </Screen>
  );
}
