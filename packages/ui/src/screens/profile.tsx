import { memo, useState } from 'react';
import { Text, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { Body, Screen, StatusBar, TabBar } from '../components/chrome';
import { Avatar } from '../components/avatar';
import { Badge } from '../components/badge';
import { Card } from '../components/card';
import { Chip } from '../components/chip';
import { EmptyState } from '../components/empty-state';
import { Icon } from '../components/icons';
import { ListRow } from '../components/list-row';
import { ContractSheet, CopyButton, SignOutSheet } from '../components/profile-parts';
import { SectionHeader } from '../components/section-header';
import { SegmentedControl } from '../components/segmented-control';
import { Skeleton, SkeletonRow } from '../components/skeleton';
import { Label, StatRow } from '../components/stat';
import { Num } from '../components/ui';
import { useAccount } from '../lib/account';
import { APP_VERSION } from '../lib/app-info';
import { useProfile, useSession } from '../lib/domains';
import { DEMO_FOLLOWING, DEMO_JOINED_AT, DEMO_PROFILE, DEMO_RULES } from '../lib/profile-demo';
import {
  allocationLabel,
  handleOf,
  loginLabel,
  memberSince,
  pinnedCount,
  ruleOrdinals,
  shortAddress,
  shortId,
} from '../lib/profile-logic';
import { routes } from '../lib/routes';
import { THEME_MODES } from '../lib/theme-logic';
import { useTheme } from '../theme';
import type { Icon as IconName } from '../components/icons';

const THEME_ICON: Record<string, IconName> = { dark: 'moon', light: 'sun', system: 'monitor' };

/**
 * 15 · PROFILE.
 *
 * Who you are here, what you have done, and the way into everything that is not
 * a tab: trading records, previous rules, copy trading, security, appearance,
 * settings, about, sign out. It leads with behaviour (rules pinned, trades taken,
 * setups refused) and never with profit.
 *
 * Every section reads its own slice and is memoised, so a change to one (a new
 * follow, a settled trade) does not repaint the rest. Signed out, each shows the
 * demo account, labelled as one.
 */
export function ProfileScreen() {
  const [sheet, setSheet] = useState<null | 'signout' | 'contract'>(null);

  return (
    <Screen label="15 · PROFILE">
      <StatusBar />
      <Body contentClassName="gap-6 pb-8 pt-5">
        <IdentitySection />
        <BehaviourSection />
        <RecordsSection />
        <RulesSection />
        <CopySection />
        <SecuritySection />
        <AppearanceSection />
        <SettingsSection />
        <AboutSection onContract={() => setSheet('contract')} />
        <SessionSection onSignOut={() => setSheet('signout')} />
      </Body>
      <TabBar active="profile" />
      <SignOutSheet open={sheet === 'signout'} onClose={() => setSheet(null)} />
      <ContractSheet open={sheet === 'contract'} onClose={() => setSheet(null)} />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IdentitySection = memo(function IdentitySection() {
  const profile = useProfile();
  const account = useAccount();

  if (profile.status === 'loading') {
    return (
      <View className="gap-4">
        <View className="flex-row items-center gap-3.5">
          <Skeleton width={56} height={56} />
          <View className="flex-1 gap-2">
            <Skeleton width="55%" height={18} />
            <Skeleton width="35%" height={12} />
          </View>
        </View>
        <Skeleton height={112} />
      </View>
    );
  }

  if (profile.status === 'empty') {
    return (
      <Card pad="none">
        <EmptyState
          icon="user"
          title="Finish signing up"
          body="Your account has no name yet. Add one and your rules, records and wallet appear here."
          action={{ label: 'Continue', href: routes.landing, primary: true }}
        />
      </Card>
    );
  }

  const demo = profile.status === 'demo';
  const settings = demo ? DEMO_PROFILE : profile.settings;
  const name = settings.name.trim() || 'Unnamed';
  const handle = handleOf(settings.username) || settings.email || '';
  const joined = demo ? DEMO_JOINED_AT : profile.settings.joinedAt;
  const login = account.loginMethods[0];

  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-3.5">
        <Avatar name={name} size="lg" tone={demo ? 'neutral' : 'signal'} />
        <View className="flex-1 gap-1">
          <Text numberOfLines={1} className="font-sans text-18 font-medium tracking-t20 text-bone">
            {name}
          </Text>
          {handle ? (
            <Text numberOfLines={1} className="font-mono text-12 text-ash">
              {handle}
            </Text>
          ) : null}
        </View>
        {demo ? <Badge label="Demo" tone="signal" icon="sparkles" /> : login ? <Chip label={loginLabel(login)} /> : null}
      </View>

      <Card pad="none">
        <View className="min-h-14 flex-row items-center gap-3 border-b border-hairline px-4 py-3">
          <Icon name="wallet" size={16} color="ash" />
          <View className="flex-1 gap-0.5">
            <Label>Wallet</Label>
            {account.address ? (
              <Num className="text-13">{shortAddress(account.address)}</Num>
            ) : (
              <Text className="font-sans text-13 text-ash">
                {demo ? 'None. Sign in to get one.' : 'Not created yet'}
              </Text>
            )}
          </View>
          {account.address ? <CopyButton value={account.address} label="wallet address" /> : null}
        </View>
        <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
          <Icon name="clock" size={16} color="ash" />
          <View className="flex-1 gap-0.5">
            <Label>Member since</Label>
            <Num className="text-13">{joined ? memberSince(joined) : '—'}</Num>
          </View>
        </View>
      </Card>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Behaviour: counts, never profit
// ---------------------------------------------------------------------------

const BehaviourSection = memo(function BehaviourSection() {
  const profile = useProfile();
  if (profile.status === 'loading') return <Skeleton height={84} />;
  if (profile.status === 'empty') return null;

  const rules = profile.status === 'demo' ? DEMO_RULES : profile.rules;
  const { taken, blocked, attempts, adherenceBps } = profile.records;
  return (
    <View className="gap-2.5">
      <StatRow
        stats={[
          { label: 'Rules', value: String(pinnedCount(rules)), sub: 'pinned', tone: 'signal' },
          { label: 'Trades', value: String(taken), sub: 'taken' },
          { label: 'Refused', value: String(blocked), sub: 'by your rule' },
        ]}
      />
      <View className="flex-row items-center gap-2 px-0.5">
        <Icon name="shield-check" size={14} color="ash" />
        <Text className="flex-1 font-sans text-12 text-ash">
          {attempts === 0 ? (
            'Nothing has been put to your rule yet.'
          ) : (
            <>
              <Num className="text-12">{formatBps(adherenceBps, { dp: 1 })}</Num> adherence across{' '}
              <Num className="text-12">{attempts}</Num> setups put to the rule.
            </>
          )}
        </Text>
      </View>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Records, rules, copy trading
// ---------------------------------------------------------------------------

const RecordsSection = memo(function RecordsSection() {
  const profile = useProfile();
  const counts =
    profile.status === 'ready' || profile.status === 'demo'
      ? `${profile.records.taken} executed · ${profile.records.blocked} refused`
      : 'Executed, refused and predictions';
  return (
    <View className="gap-2.5">
      <SectionHeader title="Trading records" />
      <Card pad="none">
        <ListRow leading="history" title="Trading records" subtitle={counts} href={routes.profileRecords} />
        <ListRow
          leading="ban"
          leadingTone="refused"
          title="Blocked trades"
          subtitle="What each refusal kept you out of"
          href={routes.blocked}
        />
        <ListRow
          leading="bar-chart"
          title="Analytics"
          subtitle="Adherence, risk, flow"
          href={routes.analytics}
          divider={false}
        />
      </Card>
    </View>
  );
});

const RulesSection = memo(function RulesSection() {
  const profile = useProfile();
  let subtitle = 'Pinned, cooling off, replaced and drafts';
  let current: string | undefined;
  if (profile.status === 'ready' || profile.status === 'demo') {
    const rules = profile.status === 'demo' ? DEMO_RULES : profile.rules;
    const ordinals = ruleOrdinals(rules);
    const active = rules.find((r) => r.active);
    current = active ? ordinals.get(active.id) : undefined;
    subtitle =
      rules.length === 0
        ? 'None pinned yet'
        : `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} · ${pinnedCount(rules)} pinned`;
  }
  return (
    <View className="gap-2.5">
      <SectionHeader title="Previous rules" />
      <Card pad="none">
        <ListRow
          leading="scroll"
          title="Previous rules"
          subtitle={subtitle}
          {...(current ? { value: current, valueSub: 'ENFORCING' } : {})}
          href={routes.profileRules}
          divider={false}
        />
      </Card>
    </View>
  );
});

const CopySection = memo(function CopySection() {
  const profile = useProfile();
  const following =
    profile.status === 'demo' ? DEMO_FOLLOWING : profile.status === 'ready' ? profile.following : null;

  return (
    <View className="gap-2.5">
      <SectionHeader
        title="Copy trading"
        {...(following && following.length > 0 ? { count: following.length } : {})}
        action={{ label: 'Open', href: routes.copy }}
      />
      <Card pad="none">
        {profile.status === 'loading' ? (
          <SkeletonRow />
        ) : following && following.length > 0 ? (
          following.slice(0, 3).map((f) => (
            <ListRow
              key={`${f.leaderStrategyId}:${f.address ?? ''}`}
              leading="users"
              title={`Lead ${shortId(f.leaderStrategyId)}`}
              subtitle={`${allocationLabel(f.allocationBps)} of your vault${f.address ? ` · ${shortAddress(f.address)}` : ''}`}
              trailing={<Badge label={f.active ? 'Following' : 'Paused'} tone={f.active ? 'signal' : 'neutral'} />}
              href={routes.copy}
            />
          ))
        ) : (
          <ListRow
            leading="users"
            title="Not following anyone"
            subtitle="Copy a strategy by its adherence, not its P&L"
            href={routes.copy}
          />
        )}
        <ListRow
          leading="vault"
          title="Guarded vault"
          subtitle="Funds the contract enforces"
          href={routes.vault}
          divider={false}
        />
      </Card>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Security, appearance, settings
// ---------------------------------------------------------------------------

const SecuritySection = memo(function SecuritySection() {
  const account = useAccount();
  return (
    <View className="gap-2.5">
      <SectionHeader title="Security" />
      <Card pad="none">
        <ListRow
          leading="shield-check"
          title="Wallet and signing"
          subtitle={account.address ? `Monad · ${shortAddress(account.address)}` : 'Wallet, passkey, what signs what'}
          href={routes.profileSecurity}
          divider={false}
        />
      </Card>
    </View>
  );
});

const AppearanceSection = memo(function AppearanceSection() {
  const { mode, setMode } = useTheme();
  const hint = THEME_MODES.find((m) => m.mode === mode)?.hint;
  return (
    <View className="gap-2.5">
      <SectionHeader title="Appearance" />
      <Card pad="md" className="gap-3">
        <Label>Theme</Label>
        <SegmentedControl
          label="Theme"
          value={mode}
          onChange={setMode}
          options={THEME_MODES.map((m) => ({
            value: m.mode,
            label: m.label,
            icon: THEME_ICON[m.mode] ?? 'moon',
          }))}
        />
        {hint ? <Text className="font-sans text-12 text-ash">{hint}</Text> : null}
      </Card>
    </View>
  );
});

const SettingsSection = memo(function SettingsSection() {
  return (
    <View className="gap-2.5">
      <SectionHeader title="Settings" />
      <Card pad="none">
        <ListRow
          leading="sliders"
          title="Settings"
          subtitle="Haptics, chart timeframe, network"
          href={routes.profileSettings}
          divider={false}
        />
      </Card>
    </View>
  );
});

// ---------------------------------------------------------------------------
// About and session
// ---------------------------------------------------------------------------

const AboutSection = memo(function AboutSection({ onContract }: { onContract: () => void }) {
  return (
    <View className="gap-2.5">
      <SectionHeader title="About" />
      <Card pad="none">
        <ListRow
          leading="info"
          title="What the contract enforces"
          subtitle="The security model, in plain words"
          onPress={onContract}
        />
        <ListRow leading="layers" title="Version" value={APP_VERSION} chevron={false} divider={false} />
      </Card>
    </View>
  );
});

const SessionSection = memo(function SessionSection({ onSignOut }: { onSignOut: () => void }) {
  const session = useSession();
  const account = useAccount();
  const profile = useProfile();
  if (session.pending) return <SkeletonRow />;

  const who =
    profile.status === 'ready' ? profile.settings.email ?? handleOf(profile.settings.username) : undefined;
  return (
    <Card pad="none">
      {session.signedIn ? (
        <ListRow
          leading="log-out"
          title="Sign out"
          subtitle={
            who || (account.loginMethods[0] ? `Signed in with ${loginLabel(account.loginMethods[0])}` : 'Ends this session')
          }
          onPress={onSignOut}
          destructive
          divider={false}
        />
      ) : (
        <ListRow
          leading="key"
          title="Sign in"
          subtitle="Pin rules, trade and keep your record"
          href={routes.landing}
          divider={false}
        />
      )}
    </Card>
  );
});
