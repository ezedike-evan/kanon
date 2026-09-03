import Link from 'next/link';
import type { Route } from 'next';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Dot, Num } from '@/components/ui';
import { shareRoute, tradeRoute } from '@/lib/routes';
import { RULE, TRADE_ID } from '@/lib/demo';

/**
 * The device.
 *
 * The design is drawn against a 393×852 artboard. On a phone the screen is the
 * viewport; on a wide display it sits on the `canvas` ground with its artboard
 * label above it, the way the design canvas presents it.
 */
export function Screen({
  rail = 'bg-signal',
  label,
  children,
}: {
  /** The 3px accent along the top. Says what kind of screen this is. */
  rail?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh justify-center bg-canvas sm:items-center sm:p-14">
      <figure className="m-0 flex w-full flex-col gap-3 sm:w-auto">
        {label ? (
          <figcaption className="hidden font-mono text-11 tracking-w16 text-ash sm:block">
            {label}
          </figcaption>
        ) : null}
        <div className="flex h-dvh w-full flex-col overflow-hidden bg-void text-bone sm:h-device-h sm:w-device-w">
          <div className={cx('h-0.75 shrink-0', rail)} />
          {children}
        </div>
      </figure>
    </div>
  );
}

/** Device status bar. Part of the artboard, not of the product. */
export function StatusBar() {
  return (
    <div className="flex shrink-0 items-center justify-between px-5 pt-3.5 font-mono text-11 text-ash">
      <Num className="font-medium text-bone">9:41</Num>
      <div className="flex items-center gap-1.25">
        <span className="tracking-w06">5G</span>
        <div className="flex h-2.5 w-5.5 rounded-[2px] border border-hairline p-px">
          <div className="w-[72%] rounded-[1px] bg-ash" />
        </div>
      </div>
    </div>
  );
}

/**
 * Wordmark and enforcement state. The state text is always present: the point
 * of the product is that something is watching, and the header says so.
 */
export function BrandBar({
  status = 'ENFORCEMENT ACTIVE',
  dot = 'bg-signal',
}: {
  status?: string | undefined;
  dot?: string | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between px-5 pt-5.5">
      <span className="font-mono text-12 font-bold tracking-w22">KANON</span>
      <div className="flex items-center gap-1.75">
        <Dot className={dot} />
        <span className="font-mono text-10 tracking-w16 text-ash">{status}</span>
      </div>
    </div>
  );
}

/** A screen header that is not the home chrome: a title, and a way back. */
export function NavBar({
  left,
  leftHref,
  right,
  leftClassName,
}: {
  left: string;
  leftHref?: Route | undefined;
  right?: string | undefined;
  leftClassName?: string | undefined;
}) {
  const leftNode = (
    <span className={cx('font-mono text-11 tracking-w16', leftClassName ?? 'text-bone')}>
      {left}
    </span>
  );
  return (
    <div className="flex shrink-0 items-center justify-between px-5 pt-4.5">
      {leftHref ? (
        <Link href={leftHref} className="hover:text-bone">
          {leftNode}
        </Link>
      ) : (
        leftNode
      )}
      {right ? (
        <span className="font-mono text-10 tracking-w12 text-ash">{right}</span>
      ) : null}
    </div>
  );
}

type TabKey = 'rules' | 'trades' | 'chart' | 'profile';

const TABS: Array<{ key: TabKey; label: string; href: Route; round?: boolean }> = [
  { key: 'rules', label: 'RULES', href: '/' },
  { key: 'trades', label: 'TRADES', href: '/blocked' },
  { key: 'chart', label: 'CHART', href: tradeRoute(TRADE_ID) },
  { key: 'profile', label: 'PROFILE', href: shareRoute(RULE.id), round: true },
];

export function TabBar({ active }: { active: TabKey }) {
  return (
    <nav className="flex shrink-0 border-t border-hairline pt-3 pb-7.5">
      {TABS.map((tab) => {
        const on = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className="flex flex-1 flex-col items-center gap-1.75"
          >
            <div
              className={cx(
                'size-2.25',
                tab.round && 'rounded-full',
                on ? 'bg-signal' : 'border border-ash',
              )}
            />
            <span
              className={cx(
                'font-mono text-9 tracking-w12',
                on ? 'text-bone' : 'text-ash',
              )}
            >
              {tab.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** The scrolling middle of a screen. Bottom actions live outside it. */
export function Body({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cx(
        'no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Primary actions are bottom-anchored, always. */
export function Footer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cx('shrink-0 px-5 pb-8.5', className)}>{children}</div>
  );
}
