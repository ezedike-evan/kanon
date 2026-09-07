import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from '../nav';
import { cx } from '../lib/cx';

/**
 * Every figure in the product goes through `Num`. Monospaced, tabular, no
 * exceptions — a price that changes width as its digits change stops reading
 * as an instrument reading.
 */
export function Num({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Text
      className={cx('font-mono text-bone', className)}
      style={{ fontVariant: ['tabular-nums'] }}
    >
      {children}
    </Text>
  );
}

/** The small uppercase tracked label. `ash`, never bone. */
export function Meta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Text className={cx('font-mono text-9 tracking-w18 text-ash', className)}>
      {children}
    </Text>
  );
}

/** Body copy. Sans, `bone`, and never inheriting — React Native does not. */
export function Prose({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <Text className={cx('font-sans text-bone', className)}>{children}</Text>;
}

/** A square status dot. Red and green are load-bearing, so they carry a label. */
export function Dot({
  className,
  size = 'size-1.25',
}: {
  className?: string | undefined;
  size?: string | undefined;
}) {
  return <View className={cx(size, 'shrink-0', className)} />;
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <View className={cx('border border-hairline bg-panel', className)}>{children}</View>
  );
}

/** A labelled row inside a panel: label left, figure right. */
export function PanelRow({
  label,
  sub,
  value,
  className,
  valueClassName,
}: {
  label: string;
  sub?: string | undefined;
  value: ReactNode;
  className?: string | undefined;
  valueClassName?: string | undefined;
}) {
  return (
    <View
      className={cx('flex-row items-end justify-between gap-4.5 px-4 py-3.25', className)}
    >
      <View className="gap-1.75">
        <Meta>{label}</Meta>
        {sub ? (
          <Text className="font-mono text-10 tracking-w10 text-ash">{sub}</Text>
        ) : null}
      </View>
      <Num className={cx('text-26 tracking-t30', valueClassName)}>{value}</Num>
    </View>
  );
}

/*
 * Buttons take two class strings, not one. In React Native a text style set on
 * the container does not reach the label, so `className` is the box and
 * `textClassName` is the type — mixing them silently drops half the styling.
 */
interface ButtonProps {
  children: ReactNode;
  href?: string | undefined;
  onPress?: (() => void) | undefined;
  className?: string | undefined;
  textClassName?: string | undefined;
  disabled?: boolean | undefined;
}

function Button({
  children,
  href,
  onPress,
  className,
  textClassName,
  box,
  text,
  disabled,
}: ButtonProps & { box: string; text: string }) {
  const boxClass = cx(
    'w-full items-center justify-center rounded-[2px]',
    box,
    disabled && 'opacity-40',
    className,
  );
  const label = <Text className={cx('text-center', text, textClassName)}>{children}</Text>;

  return href ? (
    <Link href={href} className={boxClass}>
      {label}
    </Link>
  ) : (
    <Pressable className={boxClass} onPress={onPress} disabled={disabled} role="button">
      {label}
    </Pressable>
  );
}

/** `signal` on `void`. The action that commits you to something. */
export function PrimaryButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      box="bg-signal py-4.5 hover:bg-signal-hot active:bg-signal-hot"
      text="font-mono-bold text-13 tracking-w18 text-void"
    />
  );
}

/** `raised` with a hairline. The action that steps back. */
export function GhostButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      box="border border-hairline bg-raised py-4.25 hover:bg-raised-hot active:bg-raised-hot"
      text="font-mono-medium text-13 tracking-w14 text-bone"
    />
  );
}

/** Outlined in `refused`. Cancelling, not failing. */
export function DangerButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      box="border border-refused bg-transparent py-4.5 hover:bg-refused-wash active:bg-refused-wash"
      text="font-mono-bold text-13 tracking-w18 text-refused"
    />
  );
}

/**
 * Evidence is one tap from anywhere a claim is shown. If it took two, the word
 * "verifiable" would be marketing.
 */
export function EvidenceLink({
  label,
  hash,
  href,
  className,
}: {
  label: string;
  hash: string;
  href: string;
  className?: string | undefined;
}) {
  return (
    <Link
      href={href}
      className={cx(
        'flex-row items-center justify-between border-y border-hairline py-4',
        className,
      )}
    >
      <Text className="font-mono text-12 tracking-w04 text-verified">{label}</Text>
      <Num className="text-11 text-verified">{hash}{'  ↗'}</Num>
    </Link>
  );
}
