import Link from 'next/link';
import type { Route } from 'next';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

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
  return <span className={cx('font-mono tabular-nums', className)}>{children}</span>;
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
    <span className={cx('font-mono text-9 tracking-w18 text-ash', className)}>
      {children}
    </span>
  );
}

/** A square status dot. Red and green are load-bearing, so they carry a label. */
export function Dot({ className }: { className?: string }) {
  return <div className={cx('size-1.25 shrink-0', className)} />;
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cx('border border-hairline bg-panel', className)}>{children}</div>
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
    <div
      className={cx(
        'flex items-end justify-between gap-4.5 px-4 py-3.25',
        className,
      )}
    >
      <div className="flex flex-col gap-1.75">
        <Meta>{label}</Meta>
        {sub ? (
          <span className="font-mono text-10 tracking-w10 text-ash">{sub}</span>
        ) : null}
      </div>
      <Num className={cx('text-26 font-medium tracking-t30', valueClassName)}>
        {value}
      </Num>
    </div>
  );
}

const BUTTON_BASE =
  'w-full rounded-[2px] text-center font-mono transition-colors duration-100 cursor-pointer';

/** `signal` on `void`. The action that commits you to something. */
export function PrimaryButton({
  children,
  href,
  className,
  onClick,
  type,
}: {
  children: ReactNode;
  href?: Route | undefined;
  className?: string | undefined;
  onClick?: (() => void) | undefined;
  type?: 'button' | 'submit' | undefined;
}) {
  const classes = cx(
    BUTTON_BASE,
    'block bg-signal py-4.5 text-13 font-bold tracking-w18 text-void hover:bg-signal-hot',
    className,
  );
  return href ? (
    <Link href={href} className={classes}>
      {children}
    </Link>
  ) : (
    <button type={type ?? 'button'} className={classes} onClick={onClick}>
      {children}
    </button>
  );
}

/** `raised` with a hairline. The action that steps back. */
export function GhostButton({
  children,
  href,
  className,
  onClick,
}: {
  children: ReactNode;
  href?: Route | undefined;
  className?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const classes = cx(
    BUTTON_BASE,
    'block border border-hairline bg-raised py-4.25 text-13 font-medium tracking-w14 text-bone hover:bg-raised-hot',
    className,
  );
  return href ? (
    <Link href={href} className={classes}>
      {children}
    </Link>
  ) : (
    <button type="button" className={classes} onClick={onClick}>
      {children}
    </button>
  );
}

/** Outlined in `refused`. Cancelling, not failing. */
export function DangerButton({
  children,
  href,
  className,
  onClick,
}: {
  children: ReactNode;
  href?: Route | undefined;
  className?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const classes = cx(
    BUTTON_BASE,
    'block border border-refused bg-transparent py-4.5 text-13 font-bold tracking-w18 text-refused hover:bg-refused-wash',
    className,
  );
  return href ? (
    <Link href={href} className={classes}>
      {children}
    </Link>
  ) : (
    <button type="button" className={classes} onClick={onClick}>
      {children}
    </button>
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
  href: Route;
  className?: string | undefined;
}) {
  return (
    <Link
      href={href}
      className={cx(
        'flex items-center justify-between border-y border-hairline py-4 text-verified hover:text-verified-hot',
        className,
      )}
    >
      <span className="font-mono text-12 tracking-w04">{label}</span>
      <Num className="text-11">{hash}&nbsp;&nbsp;↗</Num>
    </Link>
  );
}
