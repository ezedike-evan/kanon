import { Pressable, Text, View } from 'react-native';
import type { Decimal, MarketSide } from '@kanon/spec';
import { cx } from '../../lib/cx';
import type { MarketAvailability } from '../../lib/market-client';
import { marketClaims } from '../../lib/predict-map';
import { assetCode, settleTerms, sideCopy, stakeChoices } from '../../lib/predict-reel';
import type { PredictMarket } from '../../lib/predict-types';
import { useHaptics } from '../../platform';
import { BottomSheet } from '../bottom-sheet';
import { EvidenceChain } from '../evidence-chain';
import { Icon } from '../icons';
import { Label } from '../stat';
import { Num } from '../ui';
import { NoteLine, Question } from './reel-parts';

/** The sheet a tap on UP or DOWN opens: the claim, three stakes, one confirm. */
export function StakeSheet({
  market,
  side,
  presets,
  stakeIdx,
  onStakeIdx,
  symbol,
  availability,
  canStake,
  busy,
  message,
  onConfirm,
  onClose,
}: {
  market: PredictMarket;
  side: MarketSide;
  presets: readonly Decimal[];
  stakeIdx: number;
  onStakeIdx: (index: number) => void;
  symbol: string;
  availability: MarketAvailability;
  /** The page would let this side be taken. */
  canStake: boolean;
  busy: boolean;
  /** A plain sentence about why the last confirm did not go through. Not an error. */
  message: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { select } = useHaptics();
  const copy = sideCopy(market, side);
  const up = side === 'above';
  const choices = stakeChoices(presets);
  const chosen = choices[stakeIdx] ?? choices[0];
  const demo = availability.state === 'demo';
  const disabled = busy || demo || !canStake || !chosen;
  const label = busy
    ? 'Signing…'
    : demo
      ? 'Sign in to take a side'
      : !canStake || !chosen
        ? 'Not available right now'
        : `Confirm ${copy.label} · ${chosen.label} ${symbol}`;

  return (
    <BottomSheet open onClose={onClose} title={`TAKE ${copy.label}`} meta={assetCode(market.asset)}>
      <Question market={market} size="md" />

      <View className="mt-4 flex-row items-start gap-2.5 border-l-2 border-hairline pl-3">
        <Icon name={up ? 'arrow-up' : 'arrow-down'} size={16} color={up ? 'long' : 'short'} strokeWidth={2} />
        <View className="shrink gap-1">
          <Text className="font-mono-medium text-13 text-bone" style={{ fontVariant: ['tabular-nums'] }}>
            {copy.label} · {copy.claim}
          </Text>
          <Text className="font-sans text-13 leading-5 text-ash">{copy.wins}</Text>
        </View>
      </View>

      <Label className="mb-2 mt-6">Stake</Label>
      <View className="flex-row gap-2">
        {choices.map((c) => {
          const on = c.index === stakeIdx;
          return (
            <Pressable
              key={c.index}
              role="button"
              aria-pressed={on}
              aria-label={`Stake ${c.label} ${symbol}`}
              onPress={() => {
                select();
                onStakeIdx(c.index);
              }}
              className={cx(
                'h-14 flex-1 items-center justify-center rounded-sm border',
                on ? 'border-bone bg-bone' : 'border-hairline bg-panel hover:bg-raised active:bg-raised',
              )}
            >
              <Num className={cx('font-mono-bold text-18', on ? 'text-void' : 'text-bone')}>{c.label}</Num>
              <Text className={cx('font-mono text-10 tracking-w10', on ? 'text-void/70' : 'text-ash')}>{symbol}</Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        role="button"
        aria-label={label}
        disabled={disabled}
        onPress={onConfirm}
        className={cx(
          'mt-5 h-16 items-center justify-center rounded-sm active:opacity-80',
          up ? 'bg-long' : 'bg-short',
          disabled && 'opacity-40',
        )}
      >
        <Text className="font-mono-bold text-15 tracking-w06 text-void" style={{ fontVariant: ['tabular-nums'] }}>
          {label}
        </Text>
      </Pressable>

      {message && !demo ? (
        <NoteLine text={message} />
      ) : (
        <Text className="mt-4 text-center font-mono text-11 leading-4 text-ash">
          Settles by arithmetic over recorded Pyth prices. No model is consulted.
        </Text>
      )}
    </BottomSheet>
  );
}

/** The claims behind a card, every one expandable to the numbers the arithmetic ran on. */
export function EvidenceSheet({ market, onClose }: { market: PredictMarket; onClose: () => void }) {
  const claims = marketClaims(market);
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={`EVIDENCE · ${assetCode(market.asset)}`}
      meta={`${claims.length} CLAIMS`}
    >
      <EvidenceChain claims={claims} />
      <Text className="mb-2 mt-4 font-sans text-12 leading-5 text-ash">
        {market.demo
          ? 'Demo card. Sign in to see markets built from live prices, with their settlement evidence.'
          : 'The result is arithmetic over recorded Pyth prices: the window’s high at or above the level, or its low at or below. Touching counts. No model is consulted.'}
      </Text>
    </BottomSheet>
  );
}

const STEPS = [
  'Every market asks one question of the recorded price: does it touch the level inside the window?',
  'The answer is arithmetic over signed Pyth prices. The window’s high at or above the level, or its low at or below. Touching counts.',
  'No model is consulted, before or after. The contract checks signatures and does the sums.',
] as const;

/** How a market settles, in three lines, and the exact terms of this one. */
export function InfoSheet({
  market,
  onEvidence,
  onClose,
}: {
  market: PredictMarket;
  onEvidence: () => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet open onClose={onClose} title="HOW IT SETTLES" meta={assetCode(market.asset)}>
      <View className="gap-3.5">
        {STEPS.map((step, i) => (
          <View key={i} className="flex-row items-start gap-3">
            <View className="size-6 items-center justify-center rounded-xs border border-hairline bg-panel">
              <Num className="text-11 text-ash">{i + 1}</Num>
            </View>
            <Text className="shrink font-sans text-14 leading-5 text-bone">{step}</Text>
          </View>
        ))}
      </View>

      <Label className="mb-2 mt-6">This market</Label>
      <View className="border border-hairline bg-panel">
        {settleTerms(market).map(([name, value], i, all) => (
          <View
            key={name}
            className={cx('flex-row items-center justify-between px-3.5 py-3', i < all.length - 1 && 'border-b border-hairline')}
          >
            <Text className="font-mono text-12 text-ash">{name}</Text>
            <Num className="text-12">{value}</Num>
          </View>
        ))}
      </View>

      <Pressable
        role="button"
        aria-label="See the evidence"
        onPress={onEvidence}
        className="mb-2 mt-5 h-14 flex-row items-center justify-center gap-2 rounded-sm border border-verified/50 bg-verified/10 active:opacity-80"
      >
        <Icon name="shield-check" size={18} color="verified" />
        <Text className="font-mono-medium text-13 text-verified">See the evidence</Text>
      </Pressable>
    </BottomSheet>
  );
}
