import { memo, useState } from 'react';
import { Text, View } from 'react-native';
import { Body } from '../components/chrome';
import { ListRow } from '../components/list-row';
import { ProfileFrame } from '../components/profile/frame';
import { AppearanceCard, BehaviourSection, CopyCard, IdentitySection } from '../components/profile/sections';
import { ContractSheet, SignOutSheet } from '../components/profile-parts';
import { Card } from '../components/card';
import { SectionHeader } from '../components/section-header';
import { SkeletonRow } from '../components/skeleton';
import { useAccount } from '../lib/account';
import { APP_VERSION } from '../lib/app-info';
import { useProfile, useSession } from '../lib/domains';
import { DEMO_FOLLOWING, DEMO_RULES } from '../lib/profile-demo';
import { handleOf, loginLabel, pinnedCount, ruleOrdinals, shortAddress } from '../lib/profile-logic';
import { routes } from '../lib/routes';

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
    <ProfileFrame
      section="overview"
      label="15 · PROFILE"
      overlay={
        <>
          <SignOutSheet open={sheet === 'signout'} onClose={() => setSheet(null)} />
          <ContractSheet open={sheet === 'contract'} onClose={() => setSheet(null)} />
        </>
      }
    >
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
    </ProfileFrame>
  );
}

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
  const count = profile.status === 'demo' ? DEMO_FOLLOWING.length : profile.status === 'ready' ? profile.following.length : 0;
  return (
    <View className="gap-2.5">
      <SectionHeader title="Copy trading" {...(count > 0 ? { count } : {})} action={{ label: 'Open', href: routes.copy }} />
      <CopyCard />
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
  return (
    <View className="gap-2.5">
      <SectionHeader title="Appearance" />
      <AppearanceCard />
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
