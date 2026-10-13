import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { ActiveRuleAutopilotSheet } from '../components/autopilot';
import { Col, Row, Screen, StatusBar, TabBar } from '../components/chrome';
import { ActivitySection } from '../components/home/activity';
import { AskAiCard } from '../components/home/ask-ai';
import { HomeFoot } from '../components/home/foot';
import { HomeHeader } from '../components/home/header';
import { LeadsSection } from '../components/home/leads';
import { MarketsSection } from '../components/home/markets';
import { RuleSection, RuleSkeleton } from '../components/home/rule';
import { StatsGrid, StatsSkeleton } from '../components/home/stats';
import { cx } from '../lib/cx';
import { useKanonSelector } from '../lib/data';
import { web } from '../lib/desktop';
import { useHomeData } from '../lib/domains';
import { shallowEqual } from '../lib/store';
import { isWeb } from '../platform';
import { useTheme } from '../theme';

/**
 * The part of Home that reads behaviour: the stats strip and the rule. Its own
 * component and its own subscription, so a price tick (which lives in
 * `MarketsSection`) never re-renders it, and a new trade never re-renders the
 * pair list.
 */
function Core({ onAutopilot }: { onAutopilot: () => void }) {
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
      <RuleSection rule={home.rule} onAutopilot={onAutopilot} />
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
 *
 * From `lg` (1024, the web only) it is a dashboard: the header, then a main column
 * (the four behaviour tiles in one row, the rule, the pairs as a table, the ledger)
 * beside a side column (traders to follow, the AI, the shortcuts), and the quiet P&L
 * line last, full width, far below the fold. Below `lg` and on a device it is the
 * one stack it always was, in the same order; every desktop-only piece is a class
 * away from being hidden, so the server markup is right at any width.
 */
export function HomeScreen() {
  const { colors } = useTheme();
  const [epoch, setEpoch] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Autopilot's terms and its switch, for the rule in force: a sheet over the page, opened from the rule's card.
  const [autopilot, setAutopilot] = useState(false);
  const openAutopilot = useCallback(() => setAutopilot(true), []);
  const closeAutopilot = useCallback(() => setAutopilot(false), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setEpoch((e) => e + 1);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  return (
    <Screen size="column" desktop="wide" label="01 · HOME">
      <StatusBar />
      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName={cx('gap-6 px-5 pb-8 pt-4', web('lg:px-6 lg:pb-12 lg:pt-8 xl:px-10'))}
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
        <Row align="start">
          <Col span={8}>
            <Core key={`c${epoch}`} onAutopilot={openAutopilot} />
            <MarketsSection key={`m${epoch}`} />
            <LeadsSection key={`l${epoch}`} className={web('lg:hidden')} />
            <ActivitySection key={`a${epoch}`} />
            <View className={web('lg:hidden')}>
              <HomeFoot key={`f${epoch}`} />
            </View>
          </Col>
          {isWeb ? (
            <Col span={4} className="hidden lg:flex">
              <LeadsSection key={`sl${epoch}`} variant="list" />
              <AskAiCard />
              <HomeFoot key={`sf${epoch}`} part="shortcuts" />
            </Col>
          ) : null}
        </Row>
        {isWeb ? <HomeFoot key={`pf${epoch}`} part="pnl" className="hidden lg:flex" /> : null}
      </ScrollView>
      <TabBar active="home" />
      <ActiveRuleAutopilotSheet open={autopilot} onClose={closeAutopilot} />
    </Screen>
  );
}
