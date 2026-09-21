import { memo } from 'react';
import { Text, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { Avatar } from '../avatar';
import { Badge } from '../badge';
import { Card } from '../card';
import { Chip } from '../chip';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { ListRow } from '../list-row';
import { CopyButton } from '../profile-parts';
import { SegmentedControl } from '../segmented-control';
import { Skeleton, SkeletonRow } from '../skeleton';
import { Label, StatRow } from '../stat';
import { Num } from '../ui';
import { useAccount } from '../../lib/account';
import { useProfile } from '../../lib/domains';
import { DEMO_FOLLOWING, DEMO_JOINED_AT, DEMO_PROFILE, DEMO_RULES } from '../../lib/profile-demo';
import { allocationLabel, handleOf, loginLabel, memberSince, pinnedCount, shortAddress, shortId } from '../../lib/profile-logic';
import { routes } from '../../lib/routes';
import { THEME_MODES } from '../../lib/theme-logic';
import { useTheme } from '../../theme';
import type { Icon as IconName } from '../icons';

/**
 * The parts of Profile that the phone lists as sections and the desktop shows as
 * panes: who you are, what your behaviour has been, the people you copy, and the
 * theme. One implementation each, so the two layouts cannot drift.
 */

const THEME_ICON: Record<string, IconName> = { dark: 'moon', light: 'sun', system: 'monitor' };

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const IdentitySection = memo(function IdentitySection() {
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

export const BehaviourSection = memo(function BehaviourSection() {
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
// Copy trading and appearance
// ---------------------------------------------------------------------------

/** The follows held, or the way to start, and the vault. The card only; the caller titles it. */
export const CopyCard = memo(function CopyCard() {
  const profile = useProfile();
  const following =
    profile.status === 'demo' ? DEMO_FOLLOWING : profile.status === 'ready' ? profile.following : null;

  return (
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
  );
});

/** The theme choice and what it does. The card only; the caller titles it. */
export const AppearanceCard = memo(function AppearanceCard() {
  const { mode, setMode } = useTheme();
  const hint = THEME_MODES.find((m) => m.mode === mode)?.hint;
  return (
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
  );
});
