import { ScrollView, Text, View } from 'react-native';
import { draftSummary, type DraftLineView } from '../../lib/ai-chat';
import type { ReviewSegment } from '../../lib/data';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { Num, PrimaryButton } from '../ui';
import { DraftDetail } from './draft-dock';

/**
 * The spec draft on a desktop: a panel beside the conversation that is always
 * there, instead of the phone's collapsible dock. It says the same things the dock
 * does (`DraftDetail` is the one body), and the way onward is the same button.
 *
 * The three rules hold here as they do on a phone. The AI proposes and never pins:
 * nothing on this panel writes a rule, and `Review and pin` only takes the person
 * to the review, where they read every value and sign. Every value the AI chose
 * for itself is marked DEFAULT. Nothing navigates on its own.
 */
export function DraftPanel({
  hasSpec,
  lines,
  plain,
  label,
  compiling,
  sample,
  onReview,
}: {
  hasSpec: boolean;
  lines: readonly DraftLineView[];
  plain: readonly (readonly ReviewSegment[])[];
  label: string;
  compiling: boolean;
  sample: boolean;
  onReview: () => void;
}) {
  const sum = draftSummary(lines);
  return (
    <View role="complementary" aria-label="Spec draft" className="min-h-0 flex-1 border-l border-hairline bg-panel">
      <View className="shrink-0 flex-row items-center gap-3 border-b border-hairline px-5 pb-3 pt-4">
        <View className="size-9 items-center justify-center rounded-sm border border-hairline bg-raised">
          <Icon name="list" size={16} color="signal" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text role="heading" className="font-mono-medium text-11 uppercase tracking-w10 text-bone">
            {sample ? 'Sample draft' : 'Spec draft'}
          </Text>
          <Num className="text-11 text-ash">
            {!hasSpec
              ? 'Nothing yet'
              : compiling
                ? 'Updating'
                : sum.changed > 0
                  ? `${sum.total} lines · ${sum.changed} changed`
                  : `${sum.total} lines · not pinned`}
          </Num>
        </View>
      </View>

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="grow gap-4 px-5 py-4"
        showsVerticalScrollIndicator={false}
      >
        {hasSpec ? (
          <DraftDetail lines={lines} plain={plain} label={label} />
        ) : (
          <EmptyState
            icon="list"
            title="The spec forms here"
            body="Say a rule and its parameters appear beside the conversation, every value the AI chose for itself marked DEFAULT."
            className="my-auto"
          />
        )}
      </ScrollView>

      <View className="shrink-0 gap-2.5 border-t border-hairline px-5 py-4">
        <PrimaryButton
          onPress={onReview}
          disabled={!hasSpec || compiling}
          className="h-11 py-0"
          textClassName="text-11 uppercase tracking-w10"
        >
          Review and pin
        </PrimaryButton>
        <Text className="font-sans text-12 leading-[18px] text-ash">
          The AI proposes. Nothing is pinned until you have read every value in the review and signed it.
        </Text>
      </View>
    </View>
  );
}
