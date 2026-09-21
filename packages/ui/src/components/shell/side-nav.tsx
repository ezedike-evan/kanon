import { Text, View } from 'react-native';
import { Avatar } from '../avatar';
import { Icon } from '../icons';
import { Dot } from '../ui';
import { Link } from '../../nav';
import { cx } from '../../lib/cx';
import { useProfile, useSession } from '../../lib/domains';
import { accountChipOf } from '../../lib/account-chip';
import { routes } from '../../lib/routes';
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
 * One destination. The current one changes three things together, as the bottom
 * bar's tab does: a 2px `signal` bar on the leading edge, a `raised` ground, and
 * the icon and label to `bone`. The AI item keeps its `signal` tile whether or
 * not it is current, the way the raised centre button does on a phone.
 */
function NavItem({ tab, on }: { tab: TabDef; on: boolean }) {
  const ai = tab.key === 'create';
  return (
    <Link
      href={tab.href}
      aria-label={ai ? 'AI strategy builder' : tab.navLabel}
      {...(on ? ({ 'aria-current': 'page' } as object) : null)}
      className={cx(
        'relative h-11 flex-row items-center gap-3 rounded-sm pl-3 pr-2.5',
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
      <Text
        className={cx(
          'flex-1 text-13',
          ai ? 'font-mono-bold tracking-w08' : 'font-sans font-medium',
          on ? 'text-bone' : ai ? 'text-signal' : 'text-ash',
        )}
      >
        {ai ? tab.label : tab.navLabel}
      </Text>
      {ai ? <Text className="font-mono text-10 tracking-w08 text-ash">STRATEGY</Text> : null}
    </Link>
  );
}

/** The bottom of the rail: who is signed in, and the way to Profile. Signed out it says so. */
function AccountChip({ active }: { active: boolean }) {
  const profile = useProfile();
  const session = useSession();
  const chip = accountChipOf(profile, session);
  return (
    <Link
      href={routes.profile}
      aria-label={`Account: ${chip.name}. Open profile`}
      className={cx(
        'min-h-14 flex-row items-center gap-3 rounded-sm border border-hairline px-3 py-2.5',
        EASE,
        FOCUS,
        active ? 'bg-raised' : 'bg-transparent hover:bg-raised/60 active:bg-raised',
      )}
    >
      <Avatar name={chip.name} size="sm" tone={chip.demo || profile.status !== 'ready' ? 'neutral' : 'signal'} />
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
      <Icon name="chevron-right" size={14} color="ash" />
    </Link>
  );
}

/**
 * The desktop rail: brand, the five destinations, the account. From `lg` up;
 * below it the element is `display: none` by class, so the server markup is
 * right at every width and nothing flashes. `active` is the current tab, or
 * `null` on a screen that is not a tab (the rail then lights nothing).
 *
 * A `navigation` landmark, every item a real link (Tab, Enter, and it opens in a
 * new tab), the current one marked `aria-current="page"` and by more than colour.
 */
export function SideNav({ active }: { active: TabKey | null }) {
  // The account chip reads the profile domain, so it mounts only once there is a
  // rail to show it in; until then an empty slot keeps the rail's height stable.
  const showChip = useLayout() === 'desktop';
  return (
    <View
      role="navigation"
      aria-label="Primary"
      className="hidden h-dvh w-[232px] shrink-0 border-r border-hairline bg-panel lg:flex"
    >
      <Link
        href={routes.home}
        aria-label="Kanon, home"
        className={cx('gap-2.5 px-5 pb-5 pt-5.5', FOCUS)}
      >
        <View className="flex-row items-center gap-2.5">
          <Mark />
          <Text className="font-mono-bold text-12 tracking-w22 text-bone">KANON</Text>
        </View>
        <View className="flex-row items-center gap-1.75 pl-0.5">
          <Dot className="bg-signal" />
          <Text className="font-mono text-10 tracking-w16 text-ash">ENFORCEMENT ACTIVE</Text>
        </View>
      </Link>

      <View className="mx-5 h-px bg-hairline" />

      <View className="gap-0.5 px-3 pt-4">
        {TABS.map((tab) => (
          <NavItem key={tab.key} tab={tab} on={tab.key === active} />
        ))}
      </View>

      <View className="flex-1" />

      <View className="min-h-14 px-3 pb-4">{showChip ? <AccountChip active={active === 'profile'} /> : null}</View>
    </View>
  );
}
