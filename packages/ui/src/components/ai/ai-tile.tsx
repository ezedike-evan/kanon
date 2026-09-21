import { View } from 'react-native';
import { cx } from '../../lib/cx';
import { Icon } from '../icons';

/** The assistant's mark: the sparkles glyph on a signal wash. The same glyph as the tab, so the two read as one thing. */
export function AiTile({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg'; className?: string | undefined }) {
  const box = size === 'lg' ? 'size-12' : size === 'md' ? 'size-10' : 'size-7';
  const glyph = size === 'lg' ? 22 : size === 'md' ? 20 : 14;
  return (
    <View
      aria-hidden
      className={cx('shrink-0 items-center justify-center rounded-sm border border-signal/40 bg-signal/15', box, className)}
    >
      <Icon name="sparkles" size={glyph} color="signal" />
    </View>
  );
}
