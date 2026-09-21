import { Pressable, Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { useHaptics } from '../platform';
import { Icon, type Icon as IconName } from './icons';
import { Num } from './ui';
import { TONE_COLOR, TONE_SOFT, TONE_TEXT, type Tone } from './tone';

export interface ChipProps {
  label: string;
  icon?: IconName | undefined;
  tone?: Tone | undefined;
  className?: string | undefined;
}

/** A static tag: an asset, a timeframe, a state. Not pressable; see `FilterChip`. */
export function Chip({ label, icon, tone = 'neutral', className }: ChipProps) {
  return (
    <View
      className={cx(
        'h-6 flex-row items-center gap-1 self-start rounded-xs border px-2',
        TONE_SOFT[tone],
        className,
      )}
    >
      {icon ? <Icon name={icon} size={12} color={TONE_COLOR[tone]} /> : null}
      <Text className={cx('font-mono-medium text-11 tracking-w04', TONE_TEXT[tone])}>{label}</Text>
    </View>
  );
}

export interface FilterChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** A count after the label, monospaced. */
  count?: number | undefined;
  icon?: IconName | undefined;
  className?: string | undefined;
}

/**
 * A pressable filter. Selected inverts (bone fill, void text), which reads at a
 * glance in both themes and never borrows a direction colour. Plays `select`.
 */
export function FilterChip({ label, selected, onPress, count, icon, className }: FilterChipProps) {
  const { select } = useHaptics();
  return (
    <Pressable
      role="button"
      aria-pressed={selected}
      onPress={() => {
        select();
        onPress();
      }}
      className={cx(
        'h-8 flex-row items-center gap-1.5 self-start rounded-xs border px-3',
        selected ? 'border-bone bg-bone' : 'border-hairline bg-panel hover:bg-raised active:bg-raised',
        className,
      )}
    >
      {icon ? <Icon name={icon} size={14} color={selected ? 'void' : 'ash'} /> : null}
      <Text
        className={cx(
          'font-mono-medium text-12 tracking-w04',
          selected ? 'text-void' : 'text-bone',
        )}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <Num className={cx('text-11', selected ? 'text-void/70' : 'text-ash')}>{count}</Num>
      ) : null}
    </Pressable>
  );
}
