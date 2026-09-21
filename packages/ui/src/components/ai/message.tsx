import { Pressable, Text, View } from 'react-native';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import { previewLines, type DraftLineView, type ThreadItem } from '../../lib/ai-chat';
import { Enter } from '../motion';
import { Icon } from '../icons';
import { Num } from '../ui';
import { AiTile } from './ai-tile';

type MessageItem = Extract<ThreadItem, { kind: 'message' }>;

/**
 * One turn. The two speakers differ in four ways at once, so no one of them
 * carries it alone: side, surface, a name, and the assistant's mark.
 */
export function ChatMessage({
  item,
  lines,
  onOpenDraft,
  animate,
}: {
  item: MessageItem;
  /** The current draft, for the card an assistant turn can carry. */
  lines: readonly DraftLineView[];
  onOpenDraft: () => void;
  /** Rise into place. Only for turns that arrive while the screen is open. */
  animate: boolean;
}) {
  const body =
    item.role === 'user' ? (
      <View className="items-end gap-1.5 pl-10">
        <View className="flex-row items-center gap-2">
          <Num className="text-10 text-ash">{item.at}</Num>
          <Text className="font-mono-medium text-10 uppercase tracking-w12 text-ash">You</Text>
        </View>
        <View className="rounded-sm border border-signal/40 bg-signal/15 px-3.5 py-3">
          <Text selectable className="font-sans text-15 leading-[22px] text-bone">
            {item.text}
          </Text>
        </View>
      </View>
    ) : (
      <View className="flex-row gap-2.5 pr-6">
        <AiTile size="sm" className="mt-4.5" />
        <View className="min-w-0 flex-1 gap-1.5">
          <View className="flex-row items-center gap-2">
            <Text className="font-mono-medium text-10 uppercase tracking-w12 text-bone">Strategy AI</Text>
            <Num className="text-10 text-ash">{item.at}</Num>
          </View>
          <View className="rounded-sm border border-hairline bg-panel px-3.5 py-3">
            <Text selectable className="font-sans text-15 leading-[22px] text-bone">
              {item.text}
            </Text>
            {item.embedDraft && lines.length > 0 ? <DraftEmbed lines={lines} onOpen={onOpenDraft} /> : null}
          </View>
        </View>
      </View>
    );

  return animate ? <Enter variant="diff">{body}</Enter> : body;
}

/**
 * The draft, glanceable inside the turn that produced it. What this turn
 * changed comes first, in `signal`; the whole draft is one tap away.
 */
function DraftEmbed({ lines, onOpen }: { lines: readonly DraftLineView[]; onOpen: () => void }) {
  const shown = previewLines(lines, 4);
  const changed = lines.filter((l) => l.changed).length;
  return (
    <View className="mt-3 overflow-hidden rounded-xs border border-hairline bg-sunken">
      <View className="flex-row items-center justify-between border-b border-hairline px-3 py-2">
        <View className="flex-row items-center gap-1.5">
          <Icon name="list" size={12} color="ash" />
          <Text className="font-mono-medium text-10 uppercase tracking-w12 text-ash">Spec draft</Text>
        </View>
        <Num className={cx('text-10', changed > 0 ? 'text-signal' : 'text-ash')}>
          {changed > 0 ? `${changed} changed` : `${lines.length} lines`}
        </Num>
      </View>
      <View className="gap-1 px-3 py-2.5">
        {shown.map((line) => (
          <View key={line.id} className="flex-row items-baseline gap-2">
            <Text className={cx('font-mono text-12', line.changed ? 'text-signal' : 'text-ash')}>
              {line.changed ? '+' : ' '}
            </Text>
            <Num className={cx('min-w-0 flex-1 text-12', line.changed ? 'text-signal' : 'text-ash')}>
              {line.name ? `${line.name}: ` : ''}
              <Num className={cx('text-12', line.changed ? 'text-signal' : 'text-bone')}>{line.value}</Num>
            </Num>
          </View>
        ))}
      </View>
      <Pressable
        role="button"
        aria-label="Open the full spec draft"
        onPress={onOpen}
        // On desktop the whole draft is always in the panel beside the thread; there is nothing to open.
        className={cx(
          'flex-row items-center justify-between border-t border-hairline px-3 py-2.5 active:bg-raised hover:bg-raised',
          web('lg:hidden'),
        )}
      >
        <Text className="font-mono-medium text-11 uppercase tracking-w10 text-verified">Open draft</Text>
        <Icon name="chevron-up" size={14} color="verified" strokeWidth={2} />
      </Pressable>
    </View>
  );
}
