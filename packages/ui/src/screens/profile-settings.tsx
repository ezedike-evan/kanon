import { Text, View } from 'react-native';
import { Badge } from '../components/badge';
import { Body } from '../components/chrome';
import { FilterChip } from '../components/chip';
import { Card } from '../components/card';
import { Fact, SubScreen } from '../components/profile-parts';
import { SectionHeader } from '../components/section-header';
import { SegmentedControl } from '../components/segmented-control';
import { Label } from '../components/stat';
import { CHART_TIMEFRAMES } from '../lib/chart-timeframes';
import { monad } from '../lib/monad-chain';
import { updatePreferences, usePreference } from '../lib/preferences';
import { isWeb, useHaptics, usePlatform } from '../platform';

/**
 * 15D · SETTINGS.
 *
 * Only settings that change something. Two do, and both are this device's: whether
 * it vibrates, and which timeframe the Chart tab opens on. The network is shown, not
 * offered: rules are pinned on one chain. Nothing here can loosen a rule; a rule is
 * changed only through review, and a loosening waits out its hold.
 */
export function ProfileSettingsScreen() {
  const haptics = usePreference('haptics');
  const bucket = usePreference('chartBucketSeconds');
  const { storage } = usePlatform();
  const { tap } = useHaptics();

  return (
    <SubScreen label="15D · SETTINGS" title="Settings">
      <Body contentClassName="gap-6 pb-8 pt-2">
        <View className="gap-2.5">
          <SectionHeader title="Feel" />
          <Card pad="md" className="gap-3">
            <View className="flex-row items-center justify-between gap-3">
              <Label>Haptics</Label>
              {isWeb ? <Badge label="Not in the browser" icon="info" /> : null}
            </View>
            {isWeb ? (
              <Text className="font-sans text-13 leading-[1.5] text-ash">
                A browser has no haptic engine, so nothing vibrates here. On your phone this switches presses, tab changes and
                refusals on or off.
              </Text>
            ) : (
              <>
                <SegmentedControl
                  label="Haptics"
                  value={haptics ? 'on' : 'off'}
                  onChange={(next) => {
                    updatePreferences({ haptics: next === 'on' }, storage);
                    // Felt once as it comes on; when it goes off there is, rightly, nothing.
                    if (next === 'on') tap();
                  }}
                  options={[
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
                <Text className="font-sans text-13 leading-[1.5] text-ash">
                  Presses, tab changes and refusals. A refusal is heavy on purpose: it is meant to be felt before it is read.
                </Text>
              </>
            )}
          </Card>
        </View>

        <View className="gap-2.5">
          <SectionHeader title="Chart" />
          <Card pad="md" className="gap-3">
            <Label>Opens on</Label>
            <View role="radiogroup" aria-label="Chart opens on" className="flex-row flex-wrap gap-2">
              <FilterChip
                label="Rule's"
                selected={bucket === null}
                onPress={() => updatePreferences({ chartBucketSeconds: null }, storage)}
              />
              {CHART_TIMEFRAMES.map((t) => (
                <FilterChip
                  key={t.bucketSeconds}
                  label={t.label}
                  selected={bucket === t.bucketSeconds}
                  onPress={() => updatePreferences({ chartBucketSeconds: t.bucketSeconds }, storage)}
                />
              ))}
            </View>
            <Text className="font-sans text-13 leading-[1.5] text-ash">
              Rule&apos;s opens the chart on the timeframe your rule was pinned on. Any other choice only changes which candles
              you see first. It never changes the rule.
            </Text>
          </Card>
        </View>

        <View className="gap-2.5">
          <SectionHeader title="Network" />
          <Card pad="none">
            <Fact label="Network" value={monad.name} mono={false} right={<Badge label="Read-only" icon="lock" />} />
            <Fact label="Chain ID" value={String(monad.id)} />
            <Fact label="Block time" value={`${(monad.blockTime / 1000).toFixed(1)} s`} />
            <Fact label="Explorer" value={monad.blockExplorers.default.name} mono={false} />
          </Card>
          <Text className="px-0.5 font-sans text-12 leading-[1.5] text-ash">
            Fixed. Rules are pinned on this chain and the contract that refuses a trade lives on it.
          </Text>
        </View>

        <Text className="px-0.5 font-sans text-12 leading-[1.5] text-ash">
          These settings live on this device. Your rules live on-chain and are not touched by anything here.
        </Text>
      </Body>
    </SubScreen>
  );
}
