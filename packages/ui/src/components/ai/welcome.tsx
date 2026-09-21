import { Pressable, Text, View } from 'react-native';
import type { Suggestion } from '../../lib/ai-chat';
import { cx } from '../../lib/cx';
import { useHaptics } from '../../platform';
import { Card } from '../card';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { AiTile } from './ai-tile';

/**
 * The empty thread. It says what this is in one sentence, offers four ways in
 * drawn from the patterns the spec can express, and states the boundary once:
 * the AI proposes, only you pin. Tapping a prompt writes it into the message
 * box, where it can be edited before it is sent.
 */
export function Welcome({
  suggestions,
  onPick,
}: {
  suggestions: readonly Suggestion[];
  onPick: (text: string) => void;
}) {
  return (
    <View className="gap-6 pb-2 pt-1">
      <View className="gap-3">
        <AiTile size="lg" />
        <Text role="heading" className="font-sans text-24 font-medium leading-[30px] tracking-t20 text-bone">
          Say the rule. Get a spec you can check.
        </Text>
        <Text className="font-sans text-15 leading-[22px] text-ash">
          Describe how you trade in your own words. The AI turns it into parameters a contract can enforce, and you
          review every one before anything is pinned.
        </Text>
      </View>

      {suggestions.length > 0 ? (
        <View className="gap-2.5">
          <SectionHeader title="Start from one" />
          <Card pad="none">
            {suggestions.map((s, i) => (
              <SuggestionRow key={s.id} suggestion={s} onPick={onPick} last={i === suggestions.length - 1} />
            ))}
          </Card>
        </View>
      ) : null}

      <View className="flex-row items-center gap-2">
        <Icon name="lock" size={14} color="ash" />
        <Text className="flex-1 font-sans text-12 leading-[18px] text-ash">
          The AI proposes. It never trades and it never pins. Only you can sign a rule.
        </Text>
      </View>
    </View>
  );
}

function SuggestionRow({
  suggestion,
  onPick,
  last,
}: {
  suggestion: Suggestion;
  onPick: (text: string) => void;
  last: boolean;
}) {
  const { select } = useHaptics();
  return (
    <Pressable
      role="button"
      aria-label={`Use this prompt: ${suggestion.text}`}
      onPress={() => {
        select();
        onPick(suggestion.text);
      }}
      className={cx(
        'min-h-14 flex-row items-center gap-3 px-4 py-3 hover:bg-raised active:bg-raised',
        !last && 'border-b border-hairline',
      )}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="font-mono-medium text-10 uppercase tracking-w12 text-signal">{suggestion.tag}</Text>
        <Text className="font-sans text-14 leading-5 text-bone">{suggestion.text}</Text>
      </View>
      <Icon name="pencil" size={14} color="ash" />
    </Pressable>
  );
}
