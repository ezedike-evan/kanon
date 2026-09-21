import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { Screen, StatusBar, TabBar } from '../components/chrome';
import { ActivitySection } from '../components/home/activity';
import { HomeFoot } from '../components/home/foot';
import { HomeHeader } from '../components/home/header';
import { LeadsSection } from '../components/home/leads';
import { MarketsSection } from '../components/home/markets';
import { RuleSection, RuleSkeleton } from '../components/home/rule';
import { StatsGrid, StatsSkeleton } from '../components/home/stats';
import { useKanonSelector } from '../lib/data';
import { useHomeData } from '../lib/domains';
import { shallowEqual } from '../lib/store';
import { useTheme } from '../theme';

/**
 * The part of Home that reads behaviour: the stats strip and the rule. Its own
 * component and its own subscription, so a price tick (which lives in
 * `MarketsSection`) never re-renders it, and a new trade never re-renders the
 * pair list.
 */
function Core() {
  const home = useHomeData();
  const rules = useKanonSelector(
    (s) => ({
      pinned: s.ruleHistory.filter((r) => r.status !== 'draft').length,
      active: s.ruleHistory.filter((r) => r.active).length,
    }),
    shallowEqual,
  );

  if (home.status === 'loading') {
    return (
      <>
        <StatsSkeleton />
        <RuleSkeleton />
      </>
    );
  }
  const latestTaken = home.activity.find((a) => a.kind === 'executed');
  return (
    <>
      <StatsGrid stats={home.stats} rules={rules} latestTakenId={latestTaken?.id} />
      <RuleSection rule={home.rule} />
    </>
  );
}

/**
 * HOME.
 *
 * Behaviour first: who is looking, what the rule has done (taken, refused,
 * adherence), the rule itself, then the market and the people worth following,
 * then a ledger of the latest activity. Profit is last and small, below the
 * fold, because leading with it drives the behaviour this product exists to
 * prevent.
 *
 * Each section subscribes to its own domain and to nothing above it. Pulling
 * down re-mounts them, which re-opens their subscriptions.
 */
export function HomeScreen() {
  const { colors } = useTheme();
  const [epoch, setEpoch] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setEpoch((e) => e + 1);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  return (
    <Screen label="01 · HOME">
      <StatusBar />
      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="gap-6 px-5 pb-8 pt-4"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.ash}
            colors={[colors.signal]}
            progressBackgroundColor={colors.panel}
          />
        }
      >
        <HomeHeader key={`h${epoch}`} />
        <Core key={`c${epoch}`} />
        <MarketsSection key={`m${epoch}`} />
        <LeadsSection key={`l${epoch}`} />
        <ActivitySection key={`a${epoch}`} />
        <View>
          <HomeFoot key={`f${epoch}`} />
        </View>
      </ScrollView>
      <TabBar active="home" />
    </Screen>
  );
}
