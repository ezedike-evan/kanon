import { Pressable, ScrollView, Text, View } from 'react-native';
import { cx } from '../../lib/cx';
import { draftSummary, type DraftLineView } from '../../lib/ai-chat';
import type { ReviewSegment } from '../../lib/data';
import { useReducedMotion } from '../../lib/use-keyboard';
import { Badge } from '../badge';
import { Icon } from '../icons';
import { Enter } from '../motion';
import { Label } from '../stat';
import { Num, PrimaryButton } from '../ui';

/**
 * The spec as it forms, docked between the thread and the message box.
 *
 * Collapsed it is one row: what the draft holds, and the way onward. Expanded it
 * shows the rule in plain English and every parameter, with the ones the AI
 * chose marked DEFAULT and the ones this turn moved fading up in `signal`.
 * The primary action sits at the foot in both states and never navigates by
 * itself: the review is a step the user takes.
 */
export function DraftDock({
  lines,
  plain,
  label,
  expanded,
  onToggle,
  onReview,
  compiling,
  sample,
}: {
  lines: readonly DraftLineView[];
  plain: readonly (readonly ReviewSegment[])[];
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onReview: () => void;
  compiling: boolean;
  sample: boolean;
}) {
  const reduced = useReducedMotion();
  const sum = draftSummary(lines);

  return (
    <View className="shrink-0 border-t border-hairline bg-panel">
      {expanded ? (
        <ScrollView
          style={{ maxHeight: 300 }}
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 px-5 pb-3 pt-4"
        >
          {plain.length > 0 ? (
            <View className="gap-2">
              <Label>In plain English</Label>
              {plain.map((sentence, i) => (
                <Text key={i} className="font-sans text-14 leading-[21px] text-ash">
                  {sentence.map((seg, j) =>
                    typeof seg === 'string' ? (
                      <Text key={j}>{seg}</Text>
                    ) : (
                      <Text key={j} className="font-mono-medium text-13 text-bone">
                        {seg.param}
                      </Text>
                    ),
                  )}
                </Text>
              ))}
            </View>
          ) : null}

          <View className="gap-2">
            <View className="flex-row items-center justify-between gap-3">
              <Label>Parameters</Label>
              <Num className="text-10 text-ash">{label}</Num>
            </View>
            <View className="overflow-hidden rounded-xs border border-hairline bg-sunken">
              {lines.map((line, i) => {
                const row = (
                  <View
                    className={cx(
                      'flex-row items-center justify-between gap-3 px-3 py-2',
                      i > 0 && 'border-t border-hairline',
                      line.changed && 'bg-diff-wash',
                    )}
                  >
                    <View className="min-w-0 flex-1 flex-row items-center gap-2">
                      <Text className={cx('font-mono text-12', line.changed ? 'text-signal' : 'text-ash')} numberOfLines={1}>
                        {line.name || 'note'}
                      </Text>
                      {line.inferred ? <Badge label="Default" icon="sliders" /> : null}
                    </View>
                    <Num className={cx('shrink text-12', line.changed ? 'text-signal' : 'text-bone')}>{line.value}</Num>
                  </View>
                );
                return line.changed && !reduced ? (
                  <Enter key={`${line.id}-${line.value}`} variant="diff">
                    {row}
                  </Enter>
                ) : (
                  <View key={`${line.id}-${line.value}`}>{row}</View>
                );
              })}
            </View>
            <Text className="font-sans text-12 leading-[18px] text-ash">
              {sum.defaults > 0
                ? `${sum.defaults} ${sum.defaults === 1 ? 'value here is a default' : 'values here are defaults'} the AI chose, not words you said. Each is editable in the review.`
                : 'Every value above came from your words. Each is editable in the review.'}
            </Text>
          </View>
        </ScrollView>
      ) : null}

      <View className={cx('flex-row items-center gap-3 px-5 py-2.5', expanded && 'border-t border-hairline')}>
        <Pressable
          role="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse the spec draft' : 'Expand the spec draft'}
          onPress={onToggle}
          className="min-w-0 flex-1 flex-row items-center gap-3 py-1 active:opacity-70"
        >
          <View className="size-9 items-center justify-center rounded-sm border border-hairline bg-raised">
            <Icon name="list" size={16} color="signal" />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-mono-medium text-11 uppercase tracking-w10 text-bone">
              {sample ? 'Sample draft' : 'Spec draft'}
            </Text>
            <Num className="text-11 text-ash" >
              {compiling
                ? 'Updating'
                : sum.changed > 0
                  ? `${sum.total} lines · ${sum.changed} changed`
                  : `${sum.total} lines · not pinned`}
            </Num>
          </View>
          <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size={16} color="ash" />
        </Pressable>
        <View>
          <PrimaryButton
            onPress={onReview}
            disabled={compiling}
            className="h-10 w-auto px-4 py-0"
            textClassName="text-11 uppercase tracking-w10"
          >
            Review and pin
          </PrimaryButton>
        </View>
      </View>
    </View>
  );
}
