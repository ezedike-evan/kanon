import { useEffect, useRef, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Avatar } from '../avatar';
import { IconButton } from '../icon-button';
import { Icon } from '../icons';
import { usePanelOpen } from '../panel-rail';
import { Dot } from '../ui';
import { Link } from '../../nav';
import { cx } from '../../lib/cx';
import { useProfile, useSession } from '../../lib/domains';
import { accountChipOf } from '../../lib/account-chip';
import { routes } from '../../lib/routes';
import { isWeb } from '../../platform';
import { useLayout } from './use-layout';
import { TABS, type TabDef, type TabKey } from './tabs';

/**
 * The rod: the favicon's mark (a stem, two short ticks, one long tick in
 * `signal`) drawn from boxes, so it takes the theme's colours and needs no asset.
 */
function Mark() {
  return (
    <View className="size-6 shrink-0" aria-hidden>
      <View className="absolute bg-bone" style={{ left: 2, top: 2, width: 4, height: 20 }} />
      <View className="absolute bg-bone" style={{ left: 7, top: 4, width: 6, height: 3 }} />
      <View className="absolute bg-signal" style={{ left: 7, top: 10, width: 15, height: 4 }} />
      <View className="absolute bg-bone" style={{ left: 7, top: 17, width: 6, height: 3 }} />
    </View>
  );
}

/** A 2px `signal` ring inset on the item, for keyboard focus only (never on a click). */
const FOCUS =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal';
const EASE = 'transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]';

/**
 * The navigation's two widths, as literal classes so Tailwind can see them: open,
 * and collapsed to its icon rail. `SHELL.navWidth` and `SHELL.navRailWidth` in
 * `lib/layout.ts` are the same two numbers, and `layout.test.ts` holds them
 * together.
 */
const WIDTH = { open: 'w-[232px]', rail: 'w-[56px]' } as const;

/**
 * The browser's own hover title for the control it wraps, for one drawn as an
 * icon alone. react-native-web forwards no `title` prop, so it is set on the
 * node. It sits on a plain wrapper and the control keeps its `aria-label`, so a
 * screen reader says the name once. `null` clears it: a control with its label
 * beside it needs none.
 */
function Titled({
  title,
  className,
  children,
}: {
  title: string | null;
  className?: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<View>(null);
  useEffect(() => {
    const el = ref.current as unknown as HTMLElement | null;
    if (!isWeb || !el) return;
    if (title) el.setAttribute('title', title);
    else el.removeAttribute('title');
  }, [title]);
  return (
    <View ref={ref} className={cx(className)}>
      {children}
    </View>
  );
}

/**
 * One destination. The current one changes three things together, as the bottom
 * bar's tab does: a 2px `signal` bar on the leading edge, a `raised` ground, and
 * the icon and label to `bone`. The AI item keeps its `signal` tile whether or
 * not it is current, the way the raised centre button does on a phone.
 *
 * On the rail (`open` false) it is the icon alone, still a link and still marked
 * when current. Its name stays the link's `aria-label` and becomes its hover title.
 */
function NavItem({ tab, on, open }: { tab: TabDef; on: boolean; open: boolean }) {
  const ai = tab.key === 'create';
  const name = ai ? 'AI strategy builder' : tab.navLabel;
  return (
    <Titled title={open ? null : name}>
      <Link
        href={tab.href}
        aria-label={name}
        {...(on ? ({ 'aria-current': 'page' } as object) : null)}
        className={cx(
          'relative h-11 rounded-sm',
          open ? 'flex-row items-center gap-3 pl-3 pr-2.5' : 'items-center justify-center',
          EASE,
          FOCUS,
          on ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised',
        )}
      >
        <View
          className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', on ? 'opacity-100' : 'opacity-0')}
        />
        {ai ? (
          <View className="size-7 items-center justify-center rounded-sm bg-signal">
            <Icon name={tab.icon} size={18} color="void" strokeWidth={2} />
          </View>
        ) : (
          <View className="size-7 items-center justify-center">
            <Icon name={tab.icon} size={20} color={on ? 'bone' : 'ash'} strokeWidth={on ? 2 : 1.75} />
          </View>
        )}
        {open ? (
          <Text
            className={cx(
              'flex-1 text-13',
              ai ? 'font-mono-bold tracking-w08' : 'font-sans font-medium',
              on ? 'text-bone' : ai ? 'text-signal' : 'text-ash',
            )}
          >
            {ai ? tab.label : tab.navLabel}
          </Text>
        ) : null}
        {open && ai ? <Text className="font-mono text-10 tracking-w08 text-ash">STRATEGY</Text> : null}
      </Link>
    </Titled>
  );
}

/**
 * The bottom of the rail: who is signed in, and the way to Profile. Signed out it
 * says so. On the rail it is the monogram alone, in the same place, with the name
 * in its hover title.
 */
function AccountChip({ active, open }: { active: boolean; open: boolean }) {
  const profile = useProfile();
  const session = useSession();
  const chip = accountChipOf(profile, session);
  const name = `Account: ${chip.name}. Open profile`;
  return (
    <Titled title={open ? null : name}>
      <Link
        href={routes.profile}
        aria-label={name}
        className={cx(
          'items-center rounded-sm',
          // The rail's chip is as tall as a destination, and its margins make up the open chip's height.
          open ? 'min-h-14 flex-row gap-3 border border-hairline px-3 py-2.5' : 'my-1.5 h-11 justify-center',
          EASE,
          FOCUS,
          active ? 'bg-raised' : 'bg-transparent hover:bg-raised/60 active:bg-raised',
        )}
      >
        <Avatar name={chip.name} size="sm" tone={chip.demo || profile.status !== 'ready' ? 'neutral' : 'signal'} />
        {open ? (
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="font-sans text-13 font-medium text-bone">
              {chip.name}
            </Text>
            {chip.sub ? (
              <Text numberOfLines={1} className="font-mono text-10 tracking-w06 text-ash">
                {chip.sub}
              </Text>
            ) : null}
          </View>
        ) : null}
        {open ? <Icon name="chevron-right" size={14} color="ash" /> : null}
      </Link>
    </Titled>
  );
}

/**
 * The desktop navigation: brand, the five destinations, the account. From `lg`
 * up; below it the element is `display: none` by class, so the server markup is
 * right at every width and nothing flashes. `active` is the current tab, or
 * `null` on a screen that is not a tab (the navigation then lights nothing).
 *
 * A `navigation` landmark, every item a real link (Tab, Enter, and it opens in a
 * new tab), the current one marked `aria-current="page"` and by more than colour.
 *
 * It collapses to a 56px icon rail and the pane beside it takes the width. One
 * button at the top does both, and the choice is a device preference
 * (`sideNavOpen`). On the rail every destination is its icon, one press away as
 * before; the brand is its mark, the account its monogram, and the wordmark and
 * the status line are not drawn. The change is a snap, not a slide: an animated
 * width would resize the pane, and the chart in it, on every frame.
 */
export function SideNav({ active }: { active: TabKey | null }) {
  // The account chip reads the profile domain, so it mounts only once there is a
  // rail to show it in; until then an empty slot keeps the rail's height stable.
  const showChip = useLayout() === 'desktop';
  // Open until the stored choice has been read, which is also the default, so the
  // common case paints once and stays.
  const [open, setOpen] = usePanelOpen('sideNavOpen');
  const toggle = open ? 'Collapse navigation' : 'Expand navigation';
  return (
    <View
      role="navigation"
      aria-label="Primary"
      className={cx(
        'hidden h-dvh shrink-0 border-r border-hairline bg-panel lg:flex',
        open ? WIDTH.open : WIDTH.rail,
        // The rail takes 1px on the left to answer the hairline on its right, so
        // everything in it centres on the rail's own middle, on whole pixels.
        !open && 'pl-px',
      )}
    >
      {/*
        One tree in both states, only the classes change, so the toggle keeps the
        keyboard's focus when it is pressed. The block is 90px either way, so the
        destinations below it do not move up or down.
      */}
      <View className={cx('min-h-22.5', open ? 'flex-row items-start' : 'items-center')}>
        <Titled title={open ? null : 'Kanon, home'} className={open ? 'min-w-0 flex-1' : 'self-stretch'}>
          <Link
            href={routes.home}
            aria-label="Kanon, home"
            className={cx(FOCUS, open ? 'gap-2.5 pb-5 pl-5 pt-5.5' : 'items-center pb-1 pt-5.5')}
          >
            <View className="flex-row items-center gap-2.5">
              <Mark />
              {open ? <Text className="font-mono-bold text-12 tracking-w22 text-bone">KANON</Text> : null}
            </View>
            {open ? (
              <View className="flex-row items-center gap-1.75 pl-0.5">
                <Dot className="bg-signal" />
                <Text className="font-mono text-10 tracking-w16 text-ash">ENFORCEMENT ACTIVE</Text>
              </View>
            ) : null}
          </Link>
        </Titled>
        {/* Level with the wordmark when open; under the mark on the rail. The chevron points the way the edge will move. */}
        <Titled title={toggle} className={open ? 'pr-3 pt-4.5' : 'pb-2'}>
          <IconButton
            icon={open ? 'chevron-left' : 'chevron-right'}
            label={toggle}
            expanded={open}
            size="sm"
            color="ash"
            onPress={() => setOpen(!open)}
            className={FOCUS}
          />
        </Titled>
      </View>

      {/* Open, it starts at the brand's left edge; on the rail it is as wide as the mark above it. */}
      <View className={cx('h-px bg-hairline', open ? 'mx-5' : 'w-6 self-center')} />

      <View className={cx('gap-0.5 pt-4', open ? 'px-3' : 'px-1.5')}>
        {TABS.map((tab) => (
          <NavItem key={tab.key} tab={tab} on={tab.key === active} open={open} />
        ))}
      </View>

      <View className="flex-1" />

      <View className={cx('min-h-14 pb-4', open ? 'px-3' : 'px-1.5')}>
        {showChip ? <AccountChip active={active === 'profile'} open={open} /> : null}
      </View>
    </View>
  );
}
