import { memo, useState, type ReactNode } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Badge, type BadgeProps } from '../badge';
import { Card } from '../card';
import { EmptyState } from '../empty-state';
import { Icon, type Icon as IconName } from '../icons';
import { FOCUS } from '../reel/trade-parts';
import { SectionHeader } from '../section-header';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { TONE_COLOR, type Tone } from '../tone';
import { Num } from '../ui';
import { cx } from '../../lib/cx';
import { activeChain } from '../../lib/monad-chain';
import {
  ONCHAIN_KIND_WORD,
  blockTimeLabel,
  decidingReading,
  predicateLabel,
  recordTx,
  rowSummary,
  shortSpecHash,
  type OnchainKind,
  type OnchainRow,
} from '../../lib/onchain-record';
import { ONCHAIN_EVERY_MS, ONCHAIN_NOT_CONNECTED, type OnchainRecordState } from '../../lib/onchain-record-reads';
import { timeLabel } from '../../lib/profile-logic';
import { routes } from '../../lib/routes';
import { useHaptics } from '../../platform';

/**
 * Profile's on-chain record: what the chain holds for the signed-in wallet's
 * rules, newest first. Each pin, tightening and loosening, and each trade the
 * gate refused with the predicate and the number the contract gave for it.
 *
 * The rule cards above it are the app's own account of a rule. This is the
 * chain's, read from the Kanon indexer on Envio HyperIndex, and every row is
 * its own evidence: the whole row opens its transaction on the explorer.
 *
 * A refusal is the rule doing its job, so it takes its own mark and no error
 * styling. No row carries money: the record is hashes, predicates and times.
 */

const KIND: Record<OnchainKind, { icon: IconName; tone: Tone }> = {
  // Amber is the rule binding: made, or made stricter. A loosening is the rule too, said plainly.
  pinned: { icon: 'lock', tone: 'signal' },
  tightened: { icon: 'sliders', tone: 'signal' },
  loosening_proposed: { icon: 'timer', tone: 'neutral' },
  loosening_finalized: { icon: 'unlock', tone: 'neutral' },
  refused: { icon: 'ban', tone: 'refused' },
};

const MARK: Record<NonNullable<OnchainRow['mark']>, Pick<BadgeProps, 'label' | 'tone' | 'icon'>> = {
  enforcing: { label: 'Enforcing', tone: 'signal', icon: 'lock' },
  cooling_off: { label: 'Cooling off', tone: 'signal', icon: 'timer' },
};

/** How many rows show before the rest are asked for: the record sits under the rules, not over them. */
const PREVIEW_ROWS = 6;

const TILE = 'size-8 items-center justify-center rounded-sm border border-hairline bg-raised';

/** A named figure on a row's middle line: `SPEC 0x7f3c12…c31a`. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="flex-row items-baseline gap-1.5">
      <Label className="text-10">{label}</Label>
      {children}
    </View>
  );
}

/** What the row is about: the hashes of a change, or a refusal's predicate and number. */
function Detail({ row }: { row: OnchainRow }) {
  if (row.kind === 'refused') {
    const predicate = row.predicate ?? '';
    const reading = decidingReading(predicate, row.decidingValue);
    return (
      <View className="flex-row flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The predicate as the contract emitted it, verbatim. */}
        <Text className="font-mono text-13 text-bone">{predicateLabel(predicate)}</Text>
        {reading.figure !== null ? (
          <Field label="Deciding value">
            <Num className="text-12">{reading.unit ? `${reading.figure} ${reading.unit}` : reading.figure}</Num>
          </Field>
        ) : (
          <Text className="font-sans text-12 text-ash">{reading.words}</Text>
        )}
        <Field label="Spec">
          <Num className="text-12 text-ash">{shortSpecHash(row.specHash)}</Num>
        </Field>
      </View>
    );
  }
  return (
    <View className="flex-row flex-wrap items-baseline gap-x-3 gap-y-1">
      {row.kind === 'pinned' || !row.fromHash ? (
        <Field label="Spec">
          <Num className="text-12">{shortSpecHash(row.specHash)}</Num>
        </Field>
      ) : (
        <View className="flex-row items-center gap-1.5">
          <Num className="text-12 text-ash">{shortSpecHash(row.fromHash)}</Num>
          <Icon name="arrow-right" size={12} color="ash" />
          <Num className="text-12">{shortSpecHash(row.specHash)}</Num>
        </View>
      )}
      {row.holdEndsAt !== null ? (
        <Field label="Hold ends">
          <Num className="text-12">{blockTimeLabel(row.holdEndsAt)}</Num>
        </Field>
      ) : null}
    </View>
  );
}

const RecordRow = memo(function RecordRow({ row, divider }: { row: OnchainRow; divider: boolean }) {
  const { tap } = useHaptics();
  const kind = KIND[row.kind];
  const tx = recordTx(activeChain().blockExplorers.default, row.txHash);
  return (
    <Pressable
      role="link"
      aria-label={rowSummary(row, tx)}
      onPressIn={tap}
      // A device with nothing to open a link with rejects; that is not this screen's to report.
      onPress={() => void Linking.openURL(tx.url).catch(() => undefined)}
      className={cx(
        'min-h-14 flex-row gap-3 px-4 py-3 hover:bg-raised/60 active:bg-raised',
        divider && 'border-b border-hairline',
        FOCUS,
      )}
    >
      <View className={TILE}>
        <Icon name={kind.icon} size={16} color={kind.tone === 'neutral' ? 'ash' : TONE_COLOR[kind.tone]} />
      </View>
      <View className="min-w-0 flex-1 gap-1.5">
        <View className="min-h-4.5 flex-row items-center gap-2">
          <Text numberOfLines={1} className="shrink font-sans text-14 font-medium text-bone">
            {ONCHAIN_KIND_WORD[row.kind]}
          </Text>
          {row.mark ? <Badge {...MARK[row.mark]} /> : null}
        </View>
        <Detail row={row} />
        <View className="flex-row items-center justify-between gap-3">
          <Num className="text-11 text-ash">{blockTimeLabel(row.at)}</Num>
          <View className="flex-row items-center gap-1">
            <Num className="text-12 text-verified">{tx.short}</Num>
            <Icon name="arrow-up-right" size={14} color="verified" />
          </View>
        </View>
      </View>
    </Pressable>
  );
});

/** The loading shape: a row's tile, its three lines and the transaction at its foot. */
function RowSkeleton({ divider }: { divider: boolean }) {
  return (
    <View className={cx('min-h-14 flex-row gap-3 px-4 py-3', divider && 'border-b border-hairline')}>
      <Skeleton width={32} height={32} />
      <View className="flex-1 gap-2">
        <Skeleton width="34%" height={14} />
        <Skeleton width="62%" height={12} />
        <View className="flex-row items-center justify-between">
          <Skeleton width={128} height={10} />
          <Skeleton width={96} height={12} />
        </View>
      </View>
    </View>
  );
}

/** A state with nothing to list, said in one plain sentence. Never styled as a fault. */
function Notice({ children }: { children: string }) {
  return (
    <View role="status" className="px-4 py-4">
      <Text className="max-w-[560px] font-sans text-13 leading-5 text-ash">{children}</Text>
    </View>
  );
}

/** Said once, at the foot of the record: where it is read from, and when it last was. */
function Source({ readAt }: { readAt: number | null }) {
  return (
    <View className="border-t border-hairline px-4 py-2.5">
      <Text className="font-sans text-11 leading-4 text-ash">
        Source: the Kanon indexer on Envio HyperIndex.
        {readAt !== null ? (
          <>
            {' Read at '}
            <Num className="text-11 text-ash">{`${timeLabel(readAt)} UTC`}</Num>
            {', and again every '}
            <Num className="text-11 text-ash">{Math.round(ONCHAIN_EVERY_MS / 1000)}</Num>
            {' seconds while this is open.'}
          </>
        ) : null}
      </Text>
    </View>
  );
}

function Rows({ rows, truncated }: { rows: readonly OnchainRow[]; truncated: boolean }) {
  const [all, setAll] = useState(false);
  const { tap } = useHaptics();
  const more = rows.length - PREVIEW_ROWS;
  const shown = all || more <= 0 ? rows : rows.slice(0, PREVIEW_ROWS);
  const footed = more > 0 || truncated;
  return (
    <>
      {shown.map((row, i) => (
        <RecordRow key={row.id} row={row} divider={footed || i < shown.length - 1} />
      ))}
      {more > 0 ? (
        <Pressable
          role="button"
          aria-expanded={all}
          onPressIn={tap}
          onPress={() => setAll((v) => !v)}
          className={cx('h-11 flex-row items-center justify-center gap-1.5 hover:bg-raised active:bg-raised', FOCUS)}
        >
          <Text className="font-mono-medium text-11 uppercase tracking-w08 text-bone">
            {all ? 'Show the newest' : 'Show all'}
          </Text>
          <Num className="text-11 text-ash">{all ? PREVIEW_ROWS : rows.length}</Num>
          <Icon name={all ? 'chevron-up' : 'chevron-down'} size={14} color="bone" />
        </Pressable>
      ) : null}
      {truncated && (all || more <= 0) ? (
        <Text className={cx('px-4 py-2.5 font-sans text-12 leading-[18px] text-ash', more > 0 && 'border-t border-hairline')}>
          Older rows are on-chain too. This is as far back as one read reaches.
        </Text>
      ) : null}
    </>
  );
}

export interface OnchainRecordSectionProps {
  state: OnchainRecordState;
  /** The next step for a wallet with nothing on-chain, when the screen has not already offered one. */
  forward?: { label: string; href: string } | undefined;
  className?: string | undefined;
}

export const OnchainRecordSection = memo(function OnchainRecordSection({
  state,
  forward,
  className,
}: OnchainRecordSectionProps) {
  // A record cut at the read's limit holds more than it shows, and its count says so.
  const count =
    state.status === 'ready' && state.rows.length > 0
      ? state.truncated
        ? `${state.rows.length}+`
        : state.rows.length
      : undefined;
  return (
    <View className={cx('gap-2.5', className)}>
      <SectionHeader title="On-chain record" count={count} />
      <Card pad="none">
        {state.status === 'loading' ? (
          <View aria-busy aria-label="Reading the on-chain record">
            <RowSkeleton divider />
            <RowSkeleton divider />
            <RowSkeleton divider={false} />
          </View>
        ) : state.status === 'not_connected' ? (
          <Notice>{ONCHAIN_NOT_CONNECTED}</Notice>
        ) : state.status === 'signed_out' ? (
          <EmptyState
            icon="wallet"
            title="Sign in to read your record"
            body="Each pin, change and refusal the chain holds for your wallet's rules, with its transaction."
            action={{ label: 'Sign in', href: routes.landing, primary: true }}
          />
        ) : state.status === 'no_wallet' ? (
          <Notice>This account has no wallet yet, so nothing can be on-chain for it.</Notice>
        ) : state.status === 'unavailable' ? (
          <Notice>{state.message}</Notice>
        ) : (
          <>
            {state.problem ? (
              <View role="status" className="flex-row items-center gap-2 border-b border-hairline px-4 py-2.5">
                <Icon name="refresh" size={14} color="ash" />
                <Text className="flex-1 font-sans text-12 leading-[18px] text-ash">
                  {'The newest read failed. This is the record as of '}
                  <Num className="text-12 text-ash">{`${timeLabel(state.readAt)} UTC`}</Num>
                  {'. Trying again.'}
                </Text>
              </View>
            ) : null}
            {state.rows.length === 0 ? (
              // The ordinary answer for a wallet that has not pinned: a start, not a fault.
              <EmptyState
                icon="link"
                title="Starts with your first pin"
                body="Nothing is on-chain for this wallet yet. A rule you pin appears here with its transaction."
                action={forward}
              />
            ) : (
              <Rows rows={state.rows} truncated={state.truncated} />
            )}
          </>
        )}
        <Source readAt={state.status === 'ready' && !state.problem ? state.readAt : null} />
      </Card>
    </View>
  );
});
