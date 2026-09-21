import { memo } from 'react';
import { Text, View } from 'react-native';
import { Link } from '../../nav';
import { cx } from '../../lib/cx';
import { createRoute } from '../../lib/routes';
import { useHaptics } from '../../platform';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';

/**
 * A worked example of a rule, in the words a person would use. It is only ever put
 * in the AI tab's box: nothing is sent, and the compiler still shows the spec for
 * review before anything is pinned.
 */
export const EXAMPLE_PROMPT =
  'Only go long on BTC/USD above the 4h order block, risk at most 0.5% per trade, and no trades before 09:30 UTC.';

/**
 * Desktop side column: the way into the AI tab with something to start from. The
 * whole card is a link, and says where it goes and that it sends nothing.
 */
export const AskAiCard = memo(function AskAiCard({ className }: { className?: string | undefined }) {
  const { tap } = useHaptics();
  return (
    <View className={cx('gap-2.5', className)}>
      <SectionHeader title="Ask the AI" />
      <Link
        href={createRoute(EXAMPLE_PROMPT)}
        onPressIn={tap}
        aria-label="Ask the AI. Opens the AI tab with an example rule in the box."
        className="gap-3 rounded-sm border border-hairline bg-panel p-4 hover:bg-raised active:bg-raised"
      >
        <View className="flex-row items-start gap-3">
          <View className="size-8 shrink-0 items-center justify-center rounded-sm bg-signal">
            <Icon name="sparkles" size={16} color="void" strokeWidth={2} />
          </View>
          <Text className="min-w-0 flex-1 font-sans text-13 leading-[1.5] text-ash">
            Describe the rule you keep breaking. You read the spec before anything is pinned.
          </Text>
        </View>
        <View className="border-l-2 border-signal bg-raised px-3 py-2.5">
          <Text className="font-mono text-12 leading-[1.5] text-bone">{EXAMPLE_PROMPT}</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Text className="font-mono-medium text-11 uppercase tracking-w10 text-verified">Start from this</Text>
          <Icon name="arrow-right" size={12} color="verified" strokeWidth={2} />
        </View>
      </Link>
    </View>
  );
});
