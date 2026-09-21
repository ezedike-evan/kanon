import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { useHaptics } from '../platform';
import { Icon, type Icon as IconName } from './icons';
import { Num } from './ui';
import { TONE_COLOR, TONE_TEXT, type Tone } from './tone';

export interface ListRowProps {
  /** An icon name (drawn in a 32px tile) or any node, such as an `<Avatar>`. */
  leading?: IconName | ReactNode | undefined;
  /** Tone of the icon tile when `leading` is an icon name. Default neutral. */
  leadingTone?: Tone | undefined;
  title: string;
  subtitle?: string | undefined;
  /** Right-aligned figure. Monospaced and tabular; strings go through `Num`. */
  value?: ReactNode;
  /** A second, ash line under `value`. */
  valueSub?: string | undefined;
  valueTone?: Tone | undefined;
  /** Force the trailing chevron on or off. Default: on when the row is pressable. */
  chevron?: boolean | undefined;
  href?: string | undefined;
  onPress?: (() => void) | undefined;
  /** A hairline under the row. Default true; set false on the last row of a group. */
  divider?: boolean | undefined;
  /** A trailing node in place of value/chevron, e.g. a switch or a badge. */
  trailing?: ReactNode;
  destructive?: boolean | undefined;
  className?: string | undefined;
}

function LeadingTile({ name, tone }: { name: IconName; tone: Tone }) {
  return (
    <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-raised">
      <Icon name={name} size={16} color={tone === 'neutral' ? 'ash' : TONE_COLOR[tone]} />
    </View>
  );
}

/**
 * A row in a list: leading icon or avatar, title and subtitle, a trailing
 * figure or chevron. The unit of every settings list, record list and menu.
 *
 *   <ListRow leading="shield-check" title="Security" subtitle="Passkey, sessions" href="/security" />
 *   <ListRow title="BTC/USD" subtitle="Long · 4h" value="+1.42%" valueTone="long" />
 *
 * Put rows inside a `<Card pad="none">` and set `divider={false}` on the last.
 */
export function ListRow({
  leading,
  leadingTone = 'neutral',
  title,
  subtitle,
  value,
  valueSub,
  valueTone = 'neutral',
  chevron,
  href,
  onPress,
  divider = true,
  trailing,
  destructive,
  className,
}: ListRowProps) {
  const { tap } = useHaptics();
  const pressable = Boolean(href || onPress);
  const showChevron = chevron ?? (pressable && trailing === undefined);

  const body = (
    <>
      {leading !== undefined && leading !== null ? (
        typeof leading === 'string' ? (
          <LeadingTile name={leading as IconName} tone={destructive ? 'refused' : leadingTone} />
        ) : (
          leading
        )
      ) : null}
      <View className="flex-1 gap-0.5">
        <Text
          numberOfLines={1}
          className={cx('font-sans font-medium text-14 text-bone', destructive && 'text-refused')}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} className="font-sans text-12 text-ash">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ?? (
        <>
          {value !== undefined ? (
            <View className="items-end gap-0.5">
              {typeof value === 'string' || typeof value === 'number' ? (
                <Num className={cx('text-13', TONE_TEXT[valueTone])}>{value}</Num>
              ) : (
                value
              )}
              {valueSub ? <Num className="text-11 text-ash">{valueSub}</Num> : null}
            </View>
          ) : null}
          {showChevron ? <Icon name="chevron-right" size={16} color="ash" /> : null}
        </>
      )}
    </>
  );

  const cls = cx(
    'min-h-14 flex-row items-center gap-3 px-4 py-3',
    divider && 'border-b border-hairline',
    pressable && 'active:bg-raised hover:bg-raised',
    className,
  );

  if (href) {
    return (
      <Link href={href} className={cls} onPressIn={tap}>
        {body}
      </Link>
    );
  }
  if (onPress) {
    return (
      <Pressable role="button" className={cls} onPressIn={tap} onPress={onPress}>
        {body}
      </Pressable>
    );
  }
  return <View className={cls}>{body}</View>;
}
