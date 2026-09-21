import { Pressable, Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { useHaptics } from '../platform';
import { Icon, type Icon as IconName } from './icons';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading icon, 14px. */
  icon?: IconName | undefined;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** `sm` 32px tall, `md` 40px (default). */
  size?: 'sm' | 'md' | undefined;
  /** Accessible name for the group. */
  label?: string | undefined;
  className?: string | undefined;
}

/**
 * Two to four mutually exclusive choices, one always selected. Equal-width,
 * recessed track, the selected segment lifted to `raised` with a hairline.
 * A change plays the `select` haptic.
 *
 *   <SegmentedControl options={[{ value: 'dark', label: 'Dark' }, ...]} value={mode} onChange={setMode} />
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  label,
  className,
}: SegmentedControlProps<T>) {
  const { select } = useHaptics();
  return (
    <View
      role="radiogroup"
      aria-label={label}
      className={cx('flex-row rounded-sm border border-hairline bg-sunken p-0.5', className)}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            role="radio"
            aria-checked={on}
            aria-label={option.label}
            onPress={() => {
              if (on) return;
              select();
              onChange(option.value);
            }}
            className={cx(
              'flex-1 flex-row items-center justify-center gap-1.5 rounded-xs border',
              size === 'sm' ? 'h-8' : 'h-10',
              on ? 'border-hairline bg-lift' : 'border-transparent hover:bg-lift/50',
            )}
          >
            {option.icon ? (
              <Icon name={option.icon} size={14} color={on ? 'bone' : 'ash'} />
            ) : null}
            <Text
              className={cx(
                'font-mono-medium text-12 uppercase tracking-w08',
                on ? 'text-bone' : 'text-ash',
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
