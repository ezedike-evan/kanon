import { Pressable, Text, View } from 'react-native';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { Icon } from './icons';
import { Num } from './ui';

export interface SectionHeaderProps {
  title: string;
  /** A count next to the title, monospaced: how many rows follow. */
  count?: number | string | undefined;
  /** A right-aligned link: `{ label: 'See all', href }` or `{ label, onPress }`. */
  action?: { label: string; href?: string; onPress?: () => void } | undefined;
  className?: string | undefined;
}

/**
 * Titles a group of rows or cards. The signal tick on the left is the only
 * ornament: it marks a section start the way a ruler marks an interval.
 */
export function SectionHeader({ title, count, action, className }: SectionHeaderProps) {
  const actionBody = action ? (
    <View className="flex-row items-center gap-0.5 py-1 pl-3">
      <Text className="font-mono-medium text-11 uppercase tracking-w10 text-verified">
        {action.label}
      </Text>
      <Icon name="chevron-right" size={12} color="verified" strokeWidth={2} />
    </View>
  ) : null;

  return (
    <View className={cx('flex-row items-center justify-between', className)}>
      <View className="flex-row items-center gap-2">
        <View className="h-3 w-0.5 bg-signal" />
        <Text role="heading" className="font-mono-medium text-12 uppercase tracking-w12 text-bone">
          {title}
        </Text>
        {count !== undefined ? (
          <View className="rounded-xs border border-hairline bg-raised px-1.5 py-px">
            <Num className="text-10 text-ash">{count}</Num>
          </View>
        ) : null}
      </View>
      {action ? (
        action.href ? (
          <Link href={action.href}>{actionBody}</Link>
        ) : (
          <Pressable onPress={action.onPress} role="button">
            {actionBody}
          </Pressable>
        )
      ) : null}
    </View>
  );
}
