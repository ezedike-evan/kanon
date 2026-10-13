import { memo, useState } from 'react';
import { Text, View } from 'react-native';
import { Link, useNavigator } from '../../nav';
import { useKanonSelector } from '../../lib/data';
import type { HomeRule } from '../../lib/domain-types';
import { routes } from '../../lib/routes';
import { shallowEqual } from '../../lib/store';
import { AutopilotRow } from '../autopilot';
import { Badge } from '../badge';
import { Card } from '../card';
import { Chip } from '../chip';
import { EmptyState } from '../empty-state';
import { ExpiryCountdown, useNowSeconds } from '../expiry-countdown';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { GhostButton, Num } from '../ui';

/** Hours, minutes and seconds left of a hold, ticking. Its own leaf, so the card around it never re-renders. */
function CoolingClock({ endsAtMs }: { endsAtMs: number }) {
  const now = useNowSeconds();
  return <ExpiryCountdown endsAt={Math.floor(endsAtMs / 1000)} now={now} className="text-11 text-signal" />;
}

/**
 * The active rule, small: what it is called (its predicates, in SMC language),
 * whether it is pinned or cooling off, and the hash it was pinned under. The
 * card opens the rule; the hash is the evidence one tap away. With no rule
 * pinned, the same slot is the way to build one.
 *
 * Under the rule are the two ways it is consulted: autopilot, which judges it
 * at every candle close with nobody pressing anything, and the check by hand.
 * The autopilot row opens its terms (the screen holds the sheet); it is shown
 * signed out too, where the terms can be read and the switch asks for sign-in.
 */
export const RuleSection = memo(function RuleSection({
  rule,
  onAutopilot,
}: {
  rule: HomeRule;
  /** Opens autopilot's terms and its switch for the rule in force. */
  onAutopilot: () => void;
}) {
  const nav = useNavigator();
  const extra = useKanonSelector(
    (s) => ({
      predicates: s.rule.predicates,
      specHash: s.rule.specHash,
      pinnedOn: s.rule.pinnedOn,
      endsAt: s.coolingOff?.endsAt ?? null,
      live: s.mode === 'live',
      autopilot: s.rule.autopilot,
      candleSeconds: s.rule.bucketSeconds,
    }),
    shallowEqual,
  );
  const requestProposal = useKanonSelector((s) => s.requestProposal);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function check() {
    if (checking) return;
    setChecking(true);
    setNote(null);
    try {
      const out = await requestProposal();
      if (out.status === 'proposed') nav.push(routes.proposal);
      else if (out.status === 'refused') nav.push(routes.refused);
      else setNote(out.message);
    } finally {
      setChecking(false);
    }
  }

  if (!rule.hasPinned) {
    return (
      <View className="gap-2.5">
        <SectionHeader title="Your rule" />
        <Card pad="none">
          <EmptyState
            icon="sparkles"
            title={rule.hasDraft ? 'A draft is waiting' : 'No rule pinned yet'}
            body={
              rule.hasDraft
                ? 'Nothing is enforced until you have read the spec and pinned it.'
                : 'Describe the rule you keep breaking. The AI compiles it, you review it, and the contract refuses any trade that does not satisfy it.'
            }
            action={{
              label: rule.hasDraft ? 'Review draft' : 'Build a rule with AI',
              href: rule.hasDraft ? routes.compileReview : routes.create,
              primary: true,
            }}
          />
        </Card>
      </View>
    );
  }

  const cooling = extra.endsAt !== null;
  const hash = extra.specHash;

  return (
    <View className="gap-2.5">
      <SectionHeader title="Your rule" />
      <Card pad="none">
        <Link
          href={routes.compileReview}
          aria-label={`${rule.name}. ${cooling ? 'Cooling off' : 'Pinned'}. Open the rule.`}
          className="gap-3 p-4 active:bg-raised hover:bg-raised"
        >
          <View className="flex-row items-center justify-between gap-2">
            <Num className="text-11 tracking-w10 text-signal">{rule.ordinal}</Num>
            <View className="flex-row items-center gap-2">
              {cooling ? <CoolingClock endsAtMs={extra.endsAt ?? 0} /> : null}
              <Badge
                label={cooling ? 'Cooling off' : 'Pinned'}
                tone="signal"
                icon={cooling ? 'timer' : 'lock'}
                size="md"
              />
            </View>
          </View>

          <Text className="font-mono-medium text-15 tracking-t20 text-bone">{rule.name}</Text>

          <View className="flex-row flex-wrap items-center gap-2">
            <Chip label={rule.asset} />
            <Chip label={rule.timeframe} />
            <Num className="text-11 text-ash">{extra.pinnedOn}</Num>
          </View>

          <View className="gap-2 border-t border-hairline pt-3">
            {extra.predicates.map((text) => (
              <View key={text} className="flex-row items-start gap-2">
                <View className="mt-0.5">
                  <Icon name="check" size={14} color="signal" strokeWidth={2} />
                </View>
                <Text className="flex-1 font-mono text-12 leading-[1.45] text-bone">{text}</Text>
              </View>
            ))}
          </View>

          {hash ? (
            <View className="flex-row items-center justify-between gap-2 border-t border-hairline pt-3">
              <Label>Spec hash</Label>
              <View className="flex-row items-center gap-1.5">
                <Num className="text-11 text-verified">{hash}</Num>
                <Icon name="chevron-right" size={12} color="verified" strokeWidth={2} />
              </View>
            </View>
          ) : null}
        </Link>

        <AutopilotRow
          on={extra.autopilot}
          candleSeconds={extra.candleSeconds}
          onPress={onAutopilot}
          className="border-t border-hairline"
        />

        {extra.live ? (
          <View className="gap-2 border-t border-hairline p-3">
            <GhostButton onPress={check} disabled={checking} className="py-3" textClassName="text-12 tracking-w14">
              {checking ? 'CHECKING' : 'CHECK SETUP NOW'}
            </GhostButton>
            <Text className="font-mono text-10 leading-[1.5] text-ash" accessibilityLiveRegion="polite">
              {note ??
                'Puts the market as it stands to your rule. It is proposed, or refused with the number that decided it.'}
            </Text>
          </View>
        ) : null}
      </Card>
    </View>
  );
});

/** The rule slot while Home is still loading. */
export function RuleSkeleton() {
  return (
    <View className="gap-2.5">
      <SectionHeader title="Your rule" />
      <Card pad="md" className="gap-3">
        <View className="flex-row items-center justify-between">
          <Skeleton width={56} height={11} />
          <Skeleton width={72} height={22} />
        </View>
        <Skeleton width="70%" height={16} />
        <Skeleton width="45%" height={22} />
        <Skeleton width="90%" height={12} />
        <Skeleton width="80%" height={12} />
      </Card>
    </View>
  );
}
