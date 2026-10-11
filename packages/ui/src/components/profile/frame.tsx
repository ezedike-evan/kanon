import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Screen, StatusBar, TabBar } from '../chrome';
import { Badge } from '../badge';
import { Card } from '../card';
import { Icon, type Icon as IconName } from '../icons';
import { ListRow } from '../list-row';
import { ContractPoints, ContractSheet, SignOutSheet, SubHeader } from '../profile-parts';
import { SectionHeader } from '../section-header';
import { Label } from '../stat';
import { Link, useRouteParam } from '../../nav';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import { useSession } from '../../lib/domains';
import { APP_VERSION } from '../../lib/app-info';
import { routes } from '../../lib/routes';
import { isWeb } from '../../platform';
import { AppearanceCard, BehaviourSection, CopyCard, IdentitySection, RecentTradesSection } from './sections';

/**
 * The Profile tab's frame. Every Profile route mounts it, and it is two things at
 * once:
 *
 *  - Below `lg` and on a device, the phone's push navigation: the screen's own
 *    `children` under a back header, exactly as before.
 *  - From `lg` (web only), a two-pane settings layout: a list of sections on the
 *    left and the selected section's content, inline, on the right.
 *
 * Both are in the markup and a class shows one, so the server render is right at
 * any width and nothing flashes on hydration. Each route names its own section
 * (`/profile/records` selects Trading records), so a deep link opens the pane it
 * points at and the browser's back button retraces sections like any other page.
 * The sections with no route of their own (Overview, Copy trading, Appearance,
 * About) live on `/profile` and are switched in place, `/profile?section=…`.
 */

export type ProfileSection =
  | 'overview'
  | 'records'
  | 'rules'
  | 'copy'
  | 'security'
  | 'appearance'
  | 'settings'
  | 'about';

/** The sections that have no route of their own and are switched in place on `/profile`. */
type InlineSection = Extract<ProfileSection, 'overview' | 'copy' | 'appearance' | 'about'>;
const INLINE: readonly InlineSection[] = ['overview', 'copy', 'appearance', 'about'];
const isInline = (value: string | undefined): value is InlineSection =>
  value !== undefined && (INLINE as readonly string[]).includes(value);

interface SectionDef {
  key: ProfileSection;
  label: string;
  icon: IconName;
  /** The route, or null for a section that lives on `/profile`. */
  href: string | null;
  blurb: string;
}

const SECTIONS: Record<ProfileSection, SectionDef> = {
  overview: {
    key: 'overview',
    label: 'Overview',
    icon: 'user',
    href: routes.profile,
    blurb: 'Who you are here, what you have traded, and what your rule has done.',
  },
  records: {
    key: 'records',
    label: 'Trading records',
    icon: 'history',
    href: routes.profileRecords,
    blurb: 'Every trade you took: by hand on the chart, on a timer in Predict, or through your rule. A refusal is the rule doing its job.',
  },
  rules: {
    key: 'rules',
    label: 'Previous rules',
    icon: 'scroll',
    href: routes.profileRules,
    blurb: 'Every rule you have had, as the chain holds it. Nothing here loosens one.',
  },
  copy: {
    key: 'copy',
    label: 'Copy trading',
    icon: 'users',
    href: null,
    blurb: 'Strategies you follow, judged by how faithfully they kept their own rule.',
  },
  security: {
    key: 'security',
    label: 'Security',
    icon: 'shield-check',
    href: routes.profileSecurity,
    blurb: 'The wallet that signs, and exactly what it signs.',
  },
  appearance: {
    key: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    href: null,
    blurb: 'Dark, light, or follow this device.',
  },
  settings: {
    key: 'settings',
    label: 'Settings',
    icon: 'sliders',
    href: routes.profileSettings,
    blurb: 'Only what changes something on this device. Nothing here can loosen a rule.',
  },
  about: {
    key: 'about',
    label: 'About',
    icon: 'info',
    href: null,
    blurb: 'What the contract enforces, in plain words.',
  },
};

/** The order of the list, with a hairline between groups. */
const GROUPS: ReadonlyArray<readonly ProfileSection[]> = [
  ['overview'],
  ['records', 'rules', 'copy'],
  ['security', 'appearance', 'settings'],
  ['about'],
];

/** A 2px `signal` ring inset on the row, for keyboard focus only. The same as the rail's. */
const FOCUS =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal';
const EASE = 'transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]';

const ROW = 'relative h-10 flex-row items-center gap-3 rounded-sm px-3';

/** The look of a row in the list: the current one carries the rail's three marks (bar, ground, bone). */
function RowBody({ icon, label, on, tone = 'ash' }: { icon: IconName; label: string; on: boolean; tone?: 'ash' | 'refused' }) {
  return (
    <>
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', on ? 'opacity-100' : 'opacity-0')} />
      <Icon name={icon} size={16} color={on ? 'bone' : tone} strokeWidth={on ? 2 : 1.75} />
      <Text className={cx('flex-1 font-sans text-13 font-medium', on ? 'text-bone' : 'text-ash')}>{label}</Text>
    </>
  );
}

function NavRow({
  def,
  on,
  hosted,
  onSelect,
}: {
  def: SectionDef;
  on: boolean;
  /** This route is `/profile`, so an inline section switches in place instead of navigating. */
  hosted: boolean;
  onSelect: (key: InlineSection) => void;
}) {
  const cls = cx(ROW, EASE, FOCUS, on ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised');
  const current = on ? ({ 'aria-current': 'page' } as object) : null;
  if (hosted && isInline(def.key)) {
    return (
      <Pressable role="link" aria-label={def.label} className={cls} onPress={() => onSelect(def.key as InlineSection)} {...current}>
        <RowBody icon={def.icon} label={def.label} on={on} />
      </Pressable>
    );
  }
  // A section with a route goes to it. One without goes to `/profile` opened on it.
  const href = def.href ?? `${routes.profile}?section=${def.key}`;
  return (
    <Link href={href} aria-label={def.label} className={cls} {...current}>
      <RowBody icon={def.icon} label={def.label} on={on} />
    </Link>
  );
}

function PaneHeader({ def, demo }: { def: SectionDef; demo: boolean }) {
  return (
    <View className="gap-2 border-b border-hairline pb-5">
      <View className="flex-row items-center gap-3">
        <Label className="flex-1">Profile</Label>
        {demo ? <Badge label="Demo" tone="signal" icon="sparkles" /> : null}
      </View>
      <Text role="heading" className="font-sans text-24 font-medium tracking-t25 text-bone">
        {def.label}
      </Text>
      <Text className="max-w-[560px] font-sans text-13 leading-[1.5] text-ash">{def.blurb}</Text>
    </View>
  );
}

/** The panes that live on `/profile`. */
function InlinePane({ section }: { section: InlineSection }) {
  switch (section) {
    case 'overview':
      return (
        <View className="gap-6">
          <IdentitySection />
          <BehaviourSection />
          <RecentTradesSection />
          <View className="gap-2.5">
            <SectionHeader title="Evidence" />
            <Card pad="none">
              <ListRow
                leading="ban"
                leadingTone="refused"
                title="Blocked trades"
                subtitle="What each refusal kept you out of"
                href={routes.blocked}
              />
              <ListRow leading="bar-chart" title="Analytics" subtitle="Adherence, risk, flow" href={routes.analytics} />
              <ListRow
                leading="vault"
                title="Guarded vault"
                subtitle="Funds the contract enforces"
                href={routes.vault}
                divider={false}
              />
            </Card>
          </View>
        </View>
      );
    case 'copy':
      return (
        <View className="gap-2.5">
          <SectionHeader title="Following" action={{ label: 'Open copy trading', href: routes.copy }} />
          <CopyCard />
        </View>
      );
    case 'appearance':
      return <AppearanceCard />;
    case 'about':
      return (
        <View className="gap-6">
          <Card pad="lg">
            <ContractPoints />
            <Text className="mt-4 border-t border-hairline pt-3 font-sans text-12 leading-[1.5] text-ash">
              The full write-up is docs/ARCHITECTURE.md in the Kanon repository.
            </Text>
          </Card>
          <Card pad="none">
            <ListRow leading="layers" title="Version" value={APP_VERSION} chevron={false} divider={false} />
          </Card>
        </View>
      );
  }
}

/**
 * The desktop two-pane layout. `pane` is the content of a section that has its own
 * route; the screen for that route builds it from the data it already holds, so
 * nothing is read twice. Without one, the section is one of the inline four.
 */
function ProfileDesktop({ section, pane }: { section: ProfileSection; pane?: ReactNode }) {
  const session = useSession();
  const [inline, setInline] = useState<InlineSection>('overview');
  const [sheet, setSheet] = useState<null | 'signout' | 'contract'>(null);

  // `/profile?section=appearance` opens on that section. Read after mount, like every
  // route parameter, so the server markup and the first client render agree.
  const requested = useRouteParam('section');
  useEffect(() => {
    if (section === 'overview' && isInline(requested)) setInline(requested);
  }, [section, requested]);

  const hosted = section === 'overview';
  const current: ProfileSection = hosted ? inline : section;
  const def = SECTIONS[current];

  const select = (key: InlineSection) => {
    setInline(key);
    // Keep the address honest (a reload, a shared link) without adding a history entry.
    try {
      window.history.replaceState(window.history.state, '', key === 'overview' ? routes.profile : `${routes.profile}?section=${key}`);
    } catch {
      // No history to write to: the pane still switched.
    }
  };

  // The demo mark sits on the sections that show demo data. Overview's identity carries its own.
  const demo =
    !session.pending && !session.signedIn && !['overview', 'appearance', 'settings', 'about'].includes(current);

  return (
    <View className="hidden min-h-0 flex-1 lg:flex lg:flex-row">
      <View
        role="navigation"
        aria-label="Profile sections"
        className="w-[200px] shrink-0 border-r border-hairline xl:w-[248px]"
      >
        <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-3 p-3 pt-8 xl:p-4 xl:pt-8">
          {GROUPS.map((group, g) => (
            <View key={group.join()} className={cx('gap-0.5', g > 0 && 'border-t border-hairline pt-3')}>
              {group.map((key) => (
                <NavRow key={key} def={SECTIONS[key]} on={key === current} hosted={hosted} onSelect={select} />
              ))}
            </View>
          ))}
          <View className="gap-0.5 border-t border-hairline pt-3">
            {session.signedIn ? (
              <Pressable
                role="button"
                aria-label="Sign out"
                onPress={() => setSheet('signout')}
                className={cx(ROW, EASE, FOCUS, 'hover:bg-raised/60 active:bg-raised')}
              >
                <View className="absolute inset-y-2 left-0 w-0.5 opacity-0" />
                <Icon name="log-out" size={16} color="refused" />
                <Text className="flex-1 font-sans text-13 font-medium text-refused">Sign out</Text>
              </Pressable>
            ) : (
              <Link href={routes.landing} aria-label="Sign in" className={cx(ROW, EASE, FOCUS, 'hover:bg-raised/60 active:bg-raised')}>
                <Icon name="key" size={16} color="ash" />
                <Text className="flex-1 font-sans text-13 font-medium text-ash">Sign in</Text>
              </Link>
            )}
          </View>
        </ScrollView>
      </View>

      <ScrollView
        className="min-h-0 min-w-0 flex-1"
        contentContainerClassName="px-6 pb-12 pt-8 xl:px-10"
        showsVerticalScrollIndicator={false}
      >
        <View role="region" aria-label={def.label} className="w-full max-w-[960px] gap-6">
          <PaneHeader def={def} demo={demo} />
          {hosted ? <InlinePane section={inline} /> : pane}
        </View>
      </ScrollView>

      <SignOutSheet open={sheet === 'signout'} onClose={() => setSheet(null)} />
      <ContractSheet open={sheet === 'contract'} onClose={() => setSheet(null)} />
    </View>
  );
}

/**
 * The frame every Profile route is mounted in. `title` is the phone's header
 * (with its way back); omit it for the Profile tab itself. `pane` is this route's
 * content on desktop; `children` is its content on a phone. `overlay` is the
 * screen's own sheets, which rise over the pane on either.
 */
export function ProfileFrame({
  section,
  label,
  title,
  right,
  pane,
  overlay,
  children,
}: {
  section: ProfileSection;
  label: string;
  title?: string | undefined;
  right?: ReactNode;
  pane?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Screen size="column" desktop="wide" label={label}>
      <StatusBar />
      <View className={cx('min-h-0 flex-1', web('lg:hidden'))}>
        {title ? <SubHeader title={title} right={right} /> : null}
        {children}
      </View>
      {isWeb ? <ProfileDesktop section={section} pane={pane} /> : null}
      <TabBar active="profile" />
      {overlay}
    </Screen>
  );
}
