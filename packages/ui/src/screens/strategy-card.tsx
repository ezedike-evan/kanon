import { ScrollView, Share, Text, View } from 'react-native';
import { abbreviateHash, formatBps } from '@kanon/spec';
import { Footer, NavBar, Screen } from '../components/chrome';
import { Dot, GhostButton, Meta, Num, PrimaryButton } from '../components/ui';
import { Link } from '../nav';
import { useKanonData } from '../lib/data';
import { routes } from '../lib/routes';

/**
 * 09 · SHAREABLE STRATEGY CARD.
 *
 * The growth loop, and the one artifact that leaves the app. It has to survive
 * being seen at thumbnail size, so the two figures that matter — adherence and
 * verified P&L — carry the card and everything else is supporting text.
 *
 * Nothing on it is self-reported. The link at the bottom is the whole claim.
 */
export function StrategyCardScreen() {
  const { rule: RULE, shareCard: SHARE_CARD, hasPinned, mode } = useKanonData();

  async function share() {
    try {
      await Share.share({
        message: `${RULE.name} · ${SHARE_CARD.url}\nSpec hash ${SHARE_CARD.specHash}`,
      });
    } catch {
      /* the share sheet was dismissed or is unavailable; nothing to undo */
    }
  }

  if (mode === 'live' && !hasPinned) {
    return (
      <Screen label="09 · SHAREABLE STRATEGY CARD">
        <NavBar left="←  RULES" leftHref={routes.home} leftClassName="text-ash tracking-w12" right="SHARE CARD" />
        <ScrollView
          className="min-h-0 flex-1"
          contentContainerClassName="grow justify-center px-5"
          showsVerticalScrollIndicator={false}
        >
          <Meta className="tracking-w20">NO CARD YET</Meta>
          <Text className="mt-3 font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
            A card exists once a rule is pinned.
          </Text>
          <Text className="mt-3.5 font-sans text-14 text-ash leading-[1.5]">
            It carries the spec hash and the record, so anyone can check it against the registry.
          </Text>
        </ScrollView>
        <Footer>
          <PrimaryButton href={routes.compile}>DESCRIBE A RULE</PrimaryButton>
        </Footer>
      </Screen>
    );
  }

  return (
    <Screen label="09 · SHAREABLE STRATEGY CARD">
      <NavBar
        left={`←  ${RULE.ordinal}`}
        leftHref={routes.home}
        leftClassName="text-ash tracking-w12"
        right="SHARE CARD"
      />

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="grow justify-center px-5"
        showsVerticalScrollIndicator={false}
      >
        <View className="border border-hairline bg-panel">
          <View className="border-b border-hairline px-4.5 pt-4.5 pb-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-mono-bold text-11 tracking-w22 text-bone">KANON</Text>
              <View className="flex-row items-center gap-1.5">
                <Dot className="bg-verified" />
                <Text className="font-mono text-9 tracking-w16 text-verified">
                  VERIFIED ON-CHAIN
                </Text>
              </View>
            </View>
            <Text className="mt-5 font-mono-medium text-18 tracking-t20 text-bone">
              {RULE.name}
            </Text>
            <View className="mt-2.5 flex-row gap-3.5">
              <Num className="text-10 tracking-w10 text-ash">{RULE.asset}</Num>
              <Num className="text-10 tracking-w10 text-ash">{RULE.timeframe}</Num>
              <Num className="text-10 tracking-w10 text-ash">{SHARE_CARD.window}</Num>
            </View>
          </View>

          {/* The spec itself, compressed. A reader can check it against the hash. */}
          <View className="gap-2 border-b border-hairline px-4.5 py-3.5">
            {SHARE_CARD.summary.map((line) => (
              <Num key={line} className="text-11p5 text-ash">
                {line}
              </Num>
            ))}
          </View>

          <View className="flex-row border-b border-hairline">
            <View className="flex-1 gap-2 pt-4 pb-3.5 pl-4.5">
              <Meta className="tracking-w16">ADHERENCE</Meta>
              <Num className="font-mono-medium text-30 tracking-t35 text-signal leading-[0.9]">
                {formatBps(SHARE_CARD.adherenceBps, { dp: 1 })}
              </Num>
            </View>
            <View className="flex-1 items-end gap-2 pt-4 pr-4.5 pb-3.5">
              <Meta className="tracking-w16">VERIFIED P&amp;L</Meta>
              <Num
                className={
                  SHARE_CARD.verifiedPnlBps === null
                    ? 'font-mono-medium text-30 tracking-t35 text-ash leading-[0.9]'
                    : 'font-mono-medium text-30 tracking-t35 text-long leading-[0.9]'
                }
              >
                {SHARE_CARD.verifiedPnlBps === null
                  ? '—'
                  : formatBps(SHARE_CARD.verifiedPnlBps, { signed: true, dp: 1 })}
              </Num>
            </View>
          </View>

          <View className="flex-row border-b border-hairline">
            <View className="flex-1 gap-1.75 py-3.25 pl-4.5">
              <Meta className="tracking-w16">TAKEN</Meta>
              <Num className="font-mono-medium text-15">{SHARE_CARD.taken}</Num>
            </View>
            <View className="flex-1 gap-1.75 py-3.25">
              <Meta className="tracking-w16">BLOCKED</Meta>
              <Num className="font-mono-medium text-15">{SHARE_CARD.blocked}</Num>
            </View>
            <View className="flex-1 items-end gap-1.75 py-3.25 pr-4.5">
              <Meta className="tracking-w16">OVERRIDES</Meta>
              {/* Zero, and it can only ever be zero. There is no override path. */}
              <Num className="font-mono-medium text-15">{SHARE_CARD.overrides}</Num>
            </View>
          </View>

          <View className="gap-2 bg-raised px-4.5 py-3.25">
            <View className="flex-row items-center justify-between gap-3">
              <Num className="text-11 text-ash">{SHARE_CARD.url}</Num>
              <Text className="font-mono text-10 tracking-w10 text-verified">CHECK IT ↗</Text>
            </View>
            <View className="flex-row items-center justify-between gap-3">
              <Text className="font-mono text-9 tracking-w16 text-ash">SPEC HASH</Text>
              <Num className="text-11 text-ash">{abbreviateHash(SHARE_CARD.specHash, 8, 6)}</Num>
            </View>
          </View>
        </View>
        <Text className="mt-3.5 font-mono text-10 text-ash leading-[1.5]">
          {SHARE_CARD.disclaimer}
        </Text>
        {/* Outside the card: what leaves the app is unchanged. */}
        <Link
          href={routes.analytics}
          aria-label="Analytics: adherence, risk and smart-money flow"
          className="mt-4 flex-row items-center justify-between border-y border-hairline py-3.5"
        >
          <Text className="font-mono text-11 tracking-w06 text-bone">ANALYTICS</Text>
          <Text className="font-mono text-10 tracking-w06 text-verified">ADHERENCE · RISK · FLOW ›</Text>
        </Link>
        <Link
          href={routes.vault}
          aria-label="Agent vault: funds an agent can trade inside your rule"
          className="flex-row items-center justify-between border-b border-hairline py-3.5"
        >
          <Text className="font-mono text-11 tracking-w06 text-bone">AGENT VAULT</Text>
          <Text className="font-mono text-10 tracking-w06 text-verified">WHITELIST · DRAWDOWN CAP ›</Text>
        </Link>
        <Link
          href={routes.copy}
          aria-label="Copy trading: follow a strategy from your own vault"
          className="flex-row items-center justify-between border-b border-hairline py-3.5"
        >
          <Text className="font-mono text-11 tracking-w06 text-bone">COPY</Text>
          <Text className="font-mono text-10 tracking-w06 text-verified">FOLLOW A RULE ›</Text>
        </Link>
      </ScrollView>

      <Footer className="flex-row gap-2.5">
        <GhostButton className="flex-1 py-4.25" textClassName="text-12 tracking-w12">
          SAVE IMAGE
        </GhostButton>
        <PrimaryButton onPress={share} className="flex-1 py-4.25" textClassName="text-12 tracking-w12">
          SHARE
        </PrimaryButton>
      </Footer>
    </Screen>
  );
}
