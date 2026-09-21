import { Text, View } from 'react-native';
import { cx } from '../lib/cx';

/**
 * A hairline. Horizontal by default; `vertical` stretches to its row.
 * With a `label` it becomes a captioned rule (`—— OR ——`).
 */
export function Divider({
  vertical,
  label,
  inset,
  className,
}: {
  vertical?: boolean | undefined;
  label?: string | undefined;
  /** Left inset in px, to align under a row's text rather than its icon. */
  inset?: number | undefined;
  className?: string | undefined;
}) {
  if (vertical) return <View aria-hidden className={cx('w-px self-stretch bg-hairline', className)} />;
  if (label) {
    return (
      <View aria-hidden className={cx('flex-row items-center gap-3', className)}>
        <View className="h-px flex-1 bg-hairline" />
        <Text className="font-mono text-10 uppercase tracking-w14 text-ash">{label}</Text>
        <View className="h-px flex-1 bg-hairline" />
      </View>
    );
  }
  return (
    <View
      aria-hidden
      className={cx('h-px bg-hairline', className)}
      style={inset ? { marginLeft: inset } : undefined}
    />
  );
}
