import { memo, useMemo, type ReactNode } from 'react';
import { FlatList, Linking, Pressable, Text, View } from 'react-native';
import { COOLING_OFF_SECONDS, abbreviateHash } from '@kanon/spec';
import { Badge, type BadgeProps } from '../components/badge';
import { Card } from '../components/card';
import { EmptyState } from '../components/empty-state';
import { Icon, type Icon as IconName } from '../components/icons';
import { ProfileFrame } from '../components/profile/frame';
import { CopyButton } from '../components/profile-parts';
import { Skeleton } from '../components/skeleton';
import { Label } from '../components/stat';
import { Num } from '../components/ui';
import { Link } from '../nav';
import { useHaptics } from '../platform';
import { activeChain } from '../lib/monad-chain';
import { useRules } from '../lib/profile-hooks';
import {
  explorerUrl,
  ruleOrdinals,
  ruleSections,
  stampLabel,
  type RuleEntry,
  type RuleSection,
  type RuleState,
} from '../lib/profile-logic';
import { loosenRoute, routes, shareRoute } from '../lib/routes';
import type { RuleHistoryItem } from '../lib/domain-types';

/**
 * 15B · PREVIOUS RULES.
 *
 * Every rule you have had, the one enforcing now first. A rule is shown as the
 * chain holds it: its predicates in SMC language, the date it was pinned, and
 * its spec hash with the pin transaction one tap away. Nothing here loosens a
 * rule. The one entry that changes a pinned rule goes through the review screen,
 * where tightening applies at once and loosening waits out its hold.
 */

const STATE_BADGE: Record<RuleState, Pick<BadgeProps, 'label' | 'tone' | 'icon'>> = {
  pinned: { label: 'Pinned', tone: 'signal', icon: 'lock' },
  cooling_off: { label: 'Cooling off', tone: 'signal', icon: 'timer' },
  superseded: { label: 'Replaced', tone: 'neutral', icon: 'layers' },
  draft: { label: 'Draft', tone: 'neutral', icon: 'pencil' },
};

interface Action {
  label: string;
  href: string;
  icon: IconName;
}

function actionsFor(rule: RuleHistoryItem, state: RuleState): Action[] {
  switch (state) {
    case 'pinned':
      return [
        { label: 'Rule card', href: routes.home, icon: 'scroll' },
        { label: 'Share card', href: shareRoute(rule.id), icon: 'share' },
        { label: 'Change', href: routes.compileReview, icon: 'sliders' },
      ];
    case 'cooling_off':
      return [
        { label: 'Rule card', href: routes.home, icon: 'scroll' },
        { label: 'Share card', href: shareRoute(rule.id), icon: 'share' },
        { label: 'Countdown', href: loosenRoute(rule.id), icon: 'timer' },
      ];
    case 'draft':
      return [{ label: 'Review draft', href: routes.compileReview, icon: 'pencil' }];
    case 'superseded':
      return [];
  }
}

const HOURS = Math.round(COOLING_OFF_SECONDS / 3600);

const CAPTION: Record<RuleState, string | null> = {
  pinned: `Tightening applies now. Loosening waits ${HOURS} hours, in view.`,
  cooling_off: 'A change is waiting out its hold. The current rule stays enforced until it ends.',
  draft: 'Nothing enforces a draft until you review it and pin it.',
  superseded: 'Replaced by a newer rule. Its pin stays on-chain.',
};

function FactLine({
  label,
  value,
  trailing,
  onPress,
}: {
  label: string;
  value: string;
  trailing?: ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <>
      <View className="w-16">
        <Label>{label}</Label>
      </View>
      <Num className={onPress ? 'flex-1 text-12 text-verified' : 'flex-1 text-12'}>{value}</Num>
      {trailing}
    </>
  );
  const cls = 'min-h-10 flex-row items-center gap-2 border-t border-hairline px-4 py-1.5';
  return onPress ? (
    <Pressable role="link" aria-label={`${label} on the explorer`} onPress={onPress} className={cls}>
      {body}
      <Icon name="external-link" size={14} color="verified" />
    </Pressable>
  ) : (
    <View className={cls}>{body}</View>
  );
}

const ActionCell = memo(function ActionCell({ action, last }: { action: Action; last: boolean }) {
  const { tap } = useHaptics();
  return (
    <Link
      href={action.href}
      onPressIn={tap}
      className={`h-11 flex-1 flex-row items-center justify-center gap-1.5 hover:bg-raised active:bg-raised ${last ? '' : 'border-r border-hairline'}`}
    >
      <Icon name={action.icon} size={14} color="bone" />
      <Text className="font-mono-medium text-11 uppercase tracking-w08 text-bone">{action.label}</Text>
    </Link>
  );
});

const RuleCard = memo(function RuleCard({
  rule,
  state,
  ordinal,
}: {
  rule: RuleHistoryItem;
  state: RuleState;
  ordinal: string;
}) {
  const badge = STATE_BADGE[state];
  const predicates = rule.name ? rule.name.split(' + ') : [];
  const actions = actionsFor(rule, state);
  const enforcing = state === 'pinned' || state === 'cooling_off';
  const caption = CAPTION[state];

  return (
    <View className="mb-3">
      <Card pad="none">
        <View className="flex-row items-center gap-2.5 px-4 pb-1 pt-4">
          <Text className="font-mono-bold text-12 tracking-w12 text-bone">{ordinal}</Text>
          <Badge {...badge} />
          <View className="flex-1" />
          {rule.asset ? <Num className="text-12 text-ash">{rule.asset}</Num> : null}
        </View>

        <View className="gap-2 px-4 pb-4 pt-3">
          {predicates.length > 0 ? (
            predicates.map((p) => (
              <View key={p} className="flex-row items-center gap-2.5">
                <View className={enforcing ? 'h-3.5 w-0.5 bg-signal' : 'h-3.5 w-0.5 bg-hairline'} />
                <Text className="flex-1 font-mono text-13 text-bone">{p}</Text>
              </View>
            ))
          ) : (
            <Text className="font-sans text-13 text-ash">This spec can no longer be read. Its hash is below.</Text>
          )}
        </View>

        <FactLine
          label={state === 'draft' ? 'Status' : 'Pinned'}
          value={rule.pinnedAt ? `${stampLabel(rule.pinnedAt)} UTC` : state === 'draft' ? 'Never pinned' : '—'}
        />
        <FactLine
          label="Hash"
          value={abbreviateHash(rule.specHash, 6, 4)}
          trailing={<CopyButton value={rule.specHash} label="spec hash" />}
        />
        {rule.pinTxHash ? (
          <FactLine
            label="Pin tx"
            value={abbreviateHash(rule.pinTxHash, 6, 4)}
            onPress={() =>
              void Linking.openURL(explorerUrl(activeChain().blockExplorers.default.url, 'tx', rule.pinTxHash ?? ''))
            }
          />
        ) : null}

        {actions.length > 0 ? (
          <View className="flex-row border-t border-hairline">
            {actions.map((a, i) => (
              <ActionCell key={a.label} action={a} last={i === actions.length - 1} />
            ))}
          </View>
        ) : null}
        {caption ? (
          <Text className="border-t border-hairline px-4 py-3 font-sans text-12 leading-[1.5] text-ash">{caption}</Text>
        ) : null}
      </Card>
    </View>
  );
});

const SectionRow = memo(function SectionRow({ section }: { section: RuleSection }) {
  return (
    <View className="mb-2.5 mt-3 flex-row items-center gap-2">
      <View className="h-3 w-0.5 bg-signal" />
      <Text role="heading" className="font-mono-medium text-12 uppercase tracking-w12 text-bone">
        {section.label}
      </Text>
      <View className="rounded-xs border border-hairline bg-raised px-1.5 py-px">
        <Num className="text-10 text-ash">{section.count}</Num>
      </View>
    </View>
  );
});

type Entry = RuleSection | RuleEntry<RuleHistoryItem>;

export function ProfileRulesScreen() {
  const state = useRules();
  const rules = state.status === 'ready' || state.status === 'demo' ? state.rules : null;
  const entries = useMemo<Entry[]>(() => (rules ? ruleSections(rules) : []), [rules]);
  const ordinals = useMemo(() => (rules ? ruleOrdinals(rules) : new Map<string, string>()), [rules]);

  const renderItem = useMemo(
    () =>
      function renderRule({ item }: { item: Entry }) {
        if (item.type === 'section') return <SectionRow section={item} />;
        return <RuleCard rule={item.rule} state={item.state} ordinal={ordinals.get(item.id) ?? ''} />;
      },
    [ordinals],
  );

  // The desktop pane: the same sections and cards, in the pane's own scroller, not a virtual list.
  const pane =
    state.status === 'loading' ? (
      <View className="gap-3">
        <Skeleton height={190} />
        <Skeleton height={150} />
      </View>
    ) : state.status === 'empty' ? (
      <View className="rounded-sm border border-hairline bg-panel">
        <EmptyState
          icon="scroll"
          title="No rules yet"
          body="Describe a strategy in your own words. It becomes a rule you read, sign off and pin."
          action={{ label: 'Build a rule', href: routes.create, primary: true }}
        />
      </View>
    ) : (
      <View className="max-w-[760px]">
        {entries.map((item) =>
          item.type === 'section' ? (
            <SectionRow key={item.id} section={item} />
          ) : (
            <RuleCard key={item.id} rule={item.rule} state={item.state} ordinal={ordinals.get(item.id) ?? ''} />
          ),
        )}
      </View>
    );

  return (
    <ProfileFrame
      section="rules"
      label="15B · PREVIOUS RULES"
      title="Previous rules"
      pane={pane}
      right={state.status === 'demo' ? <Badge label="Demo" tone="signal" icon="sparkles" /> : null}
    >
      {state.status === 'loading' ? (
        <View className="gap-3 px-5 pt-2">
          <Skeleton height={190} />
          <Skeleton height={150} />
        </View>
      ) : state.status === 'empty' ? (
        <View className="mx-5 mt-2 rounded-sm border border-hairline bg-panel">
          <EmptyState
            icon="scroll"
            title="No rules yet"
            body="Describe a strategy in your own words. It becomes a rule you read, sign off and pin."
            action={{ label: 'Build a rule', href: routes.create, primary: true }}
          />
        </View>
      ) : (
        <FlatList
          className="min-h-0 flex-1"
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          data={entries}
          keyExtractor={(e) => e.id}
          renderItem={renderItem}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={7}
          showsVerticalScrollIndicator={false}
        />
      )}
    </ProfileFrame>
  );
}
