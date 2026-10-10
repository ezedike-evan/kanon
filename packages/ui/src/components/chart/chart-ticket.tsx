import { Component, memo, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { baseOf } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import { useVenueOrders } from '../../lib/domains';
import { relativeTime } from '../../lib/home-format';
import { useNowMs } from '../../lib/use-now';
import type { VenueTicket } from '../../lib/use-venue-ticket';
import {
  closePositionLabel,
  formatLeverage,
  formatUsd,
  openOrderLabel,
  orderRowView,
  positionFacts,
  sheetPrimary,
  ticketLine,
  type OutcomeView,
  type TxRef,
} from '../../lib/venue-trade';
import type { VenuePositionView, VenueSide } from '../../lib/venue-types';
import { useHaptics } from '../../platform';
import { Badge } from '../badge';
import { BottomSheet } from '../bottom-sheet';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { Num } from '../ui';

/*
 * The order ticket: a real market order on the venue, for the asset on the
 * chart. One state (`useVenueTicket`, held by the screen) drawn two ways: the
 * desktop panel's `OrderTicket`, where a press on LONG or SHORT sends the order,
 * and the phone's `TicketSheet`, which the bottom bar opens and whose one
 * bottom-anchored action sends it. On both, an order only ever leaves a surface
 * that shows its size, its leverage and every limit it is held to.
 *
 * What it must never do: imply the account is the viewer's own (it is one
 * testnet account, shared by everyone signed in), style a refusal as a fault
 * (it is an answer), or show a profit or a loss (the server computes none).
 */

/** How many of the caller's orders the list shows. The newest is first. */
const RECENT_ORDERS = 5;

const SIDE_WORD: Record<VenueSide, string> = { long: 'LONG', short: 'SHORT' };

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/** A direction's arrow. Green and red never stand alone: its word is always beside it. */
function SideGlyph({ side, size = 14, onFill }: { side: VenueSide; size?: number; onFill?: boolean }) {
  return (
    <Icon
      name={side === 'long' ? 'arrow-up' : 'arrow-down'}
      size={size}
      color={onFill ? 'void' : side}
      strokeWidth={2}
    />
  );
}

/**
 * LONG or SHORT, outlined in its direction colour. On the desktop ticket a
 * press sends the order; on the phone's bar it opens the sheet on that side.
 * The label says which.
 */
export function DirectionButton({
  side,
  label,
  disabled,
  onPress,
}: {
  side: VenueSide;
  /** What a press does, for a screen reader: `Open long, 25 dollars, 2x`. */
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { tap } = useHaptics();
  const long = side === 'long';
  return (
    <Pressable
      role="button"
      aria-label={label}
      disabled={disabled}
      onPressIn={tap}
      onPress={onPress}
      className={cx(
        'h-10 flex-1 flex-row items-center justify-center gap-2 rounded-[2px] border',
        long ? 'border-long hover:bg-long/10 active:bg-long/15' : 'border-short hover:bg-short/10 active:bg-short/15',
        disabled && 'opacity-40',
      )}
    >
      <SideGlyph side={side} />
      <Text className={cx('font-mono-bold text-12 tracking-w14', long ? 'text-long' : 'text-short')}>
        {SIDE_WORD[side]}
      </Text>
    </Pressable>
  );
}

/** Reads the account again. Absent while nobody is signed in: there is nothing to read. */
function RefreshButton({ ticket }: { ticket: VenueTicket }) {
  const { tap } = useHaptics();
  if (!ticket.canRefresh) return null;
  return (
    <Pressable
      role="button"
      aria-label="Read the trading account again"
      aria-busy={ticket.refreshing}
      disabled={ticket.refreshing}
      hitSlop={10}
      onPressIn={tap}
      onPress={ticket.refresh}
      className={cx(
        'size-6 shrink-0 items-center justify-center rounded-xs hover:bg-raised active:bg-raised',
        ticket.refreshing && 'opacity-40',
      )}
    >
      <Icon name="refresh" size={14} color="ash" />
    </Pressable>
  );
}

/**
 * One choice out of a few, as a row of chips. No keyboard: every value on offer
 * is one the server takes. The chosen chip inverts to bone, which reads in both
 * themes and borrows no direction colour.
 */
function ChoiceChips({
  label,
  options,
  value,
  format,
  describe,
  onChoose,
  disabled,
  dense,
}: {
  /** The group's name for a screen reader: `Order size`. */
  label: string;
  options: readonly number[];
  value: number | null;
  format: (option: number) => string;
  /** What one chip says to a screen reader: `Size 25 dollars`. */
  describe: (option: number) => string;
  onChoose: (option: number) => void;
  disabled: boolean;
  /** 28px for the desktop panel; 44px for a thumb. */
  dense: boolean;
}) {
  const { select } = useHaptics();
  return (
    <View role="radiogroup" aria-label={label} className="flex-row flex-wrap gap-1.5">
      {options.map((option) => {
        const on = option === value;
        return (
          <Pressable
            key={option}
            role="radio"
            aria-checked={on}
            aria-label={describe(option)}
            disabled={disabled}
            onPress={() => {
              if (on) return;
              select();
              onChoose(option);
            }}
            className={cx(
              'flex-1 items-center justify-center rounded-xs border px-1',
              dense ? 'h-7 min-w-9' : 'h-11 min-w-12',
              on ? 'border-bone bg-bone' : 'border-hairline bg-panel hover:bg-raised active:bg-raised',
              disabled && 'opacity-40',
            )}
          >
            <Num className={cx('font-mono-medium text-12', on ? 'text-void' : 'text-bone')}>{format(option)}</Num>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A choice under its label, with the range the server allows it stated on the same line. */
function ChoiceGroup({ label, range, children }: { label: string; range: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Label>{label}</Label>
        <Num className="text-11 text-ash">{range}</Num>
      </View>
      {children}
    </View>
  );
}

/** Label then figure, one per row. Dense for the desktop panel; a ruled table in the sheet. */
function Facts({ rows, dense }: { rows: ReadonlyArray<readonly [string, string]>; dense: boolean }) {
  if (dense) {
    return (
      <View className="gap-1">
        {rows.map(([name, value]) => (
          <View key={name} className="flex-row items-baseline justify-between gap-3">
            <Label>{name}</Label>
            <Num className="shrink text-right text-11">{value}</Num>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View className="border border-hairline bg-panel">
      {rows.map(([name, value], i) => (
        <View
          key={name}
          className={cx(
            'flex-row items-center justify-between gap-3 px-3.5 py-2.5',
            i < rows.length - 1 && 'border-b border-hairline',
          )}
        >
          <Text className="font-mono text-12 text-ash">{name}</Text>
          <Num className="shrink text-right text-12">{value}</Num>
        </View>
      ))}
    </View>
  );
}

/** The evidence for a fill, one press away: its transaction on the block explorer. */
function TxLink({ tx }: { tx: TxRef }) {
  return (
    <Pressable
      role="link"
      aria-label={`Open transaction ${tx.short} on ${tx.explorer}`}
      hitSlop={8}
      // A device with nothing to open a link with rejects; that is not this screen's to report.
      onPress={() => void Linking.openURL(tx.url).catch(() => undefined)}
      className="flex-row items-center gap-1.5 self-start rounded-xs py-0.5 active:opacity-70"
    >
      <Text className="font-mono text-11 tracking-w04 text-verified">TX</Text>
      <Num className="text-11 text-verified">{tx.short}</Num>
      <Icon name="arrow-up-right" size={12} color="verified" />
    </Pressable>
  );
}

/**
 * The last order's answer, in place. A fill states what it did, its figures and
 * its transaction. Everything else is the server's own sentence, set the same
 * way whatever it says: a refusal is the limits doing their job, so it takes no
 * alarm colour and no warning glyph.
 */
function OutcomeBlock({ outcome, onDismiss }: { outcome: OutcomeView; onDismiss: () => void }) {
  return (
    <View role="status" accessibilityLiveRegion="polite" className="gap-2 border border-hairline bg-panel px-3 py-2.5">
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Badge label={outcome.label} className="self-center" />
          <Text numberOfLines={1} className="shrink font-mono text-10 tracking-w10 text-ash">
            {outcome.asset}
          </Text>
        </View>
        <Pressable
          role="button"
          aria-label="Dismiss this result"
          hitSlop={10}
          onPress={onDismiss}
          className="size-5 items-center justify-center rounded-xs hover:bg-raised active:bg-raised"
        >
          <Icon name="x" size={12} color="ash" />
        </Pressable>
      </View>
      {outcome.side && outcome.headline ? (
        <View className="flex-row items-center gap-1.5">
          <SideGlyph side={outcome.side} size={12} />
          <Text
            className={cx(
              'font-mono-bold text-11 uppercase tracking-w14',
              outcome.side === 'long' ? 'text-long' : 'text-short',
            )}
          >
            {outcome.headline}
          </Text>
        </View>
      ) : (
        <Num className="text-11 leading-4">{outcome.text}</Num>
      )}
      {outcome.facts.length > 0 ? <Facts rows={outcome.facts} dense /> : null}
      {outcome.tx ? (
        <TxLink tx={outcome.tx} />
      ) : outcome.txMissing ? (
        <Text className="font-mono text-10 leading-4 text-ash">{outcome.txMissing}</Text>
      ) : null}
    </View>
  );
}

/**
 * What the account holds open on this asset: side, size, entry, leverage and
 * collateral. No mark price and no result. With `onClose` it carries its own
 * CLOSE; the sheet leaves that out, since its close is the bottom-anchored action.
 */
function PositionBlock({
  position,
  dense,
  onClose,
  closing,
  locked,
}: {
  position: VenuePositionView;
  dense: boolean;
  onClose?: (() => void) | undefined;
  closing: boolean;
  locked: boolean;
}) {
  const { tap } = useHaptics();
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <Label>Open position</Label>
        <View className="flex-row items-center gap-1.5">
          <SideGlyph side={position.side} size={12} />
          <Text
            className={cx(
              'font-mono-bold text-11 tracking-w14',
              position.side === 'long' ? 'text-long' : 'text-short',
            )}
          >
            {SIDE_WORD[position.side]}
          </Text>
        </View>
      </View>
      <Facts rows={positionFacts(position)} dense={dense} />
      {onClose ? (
        <Pressable
          role="button"
          aria-label={closePositionLabel(position)}
          disabled={locked}
          onPressIn={tap}
          onPress={onClose}
          className={cx(
            'h-9 items-center justify-center rounded-[2px] border border-bone hover:bg-bone/10 active:bg-bone/15',
            locked && 'opacity-40',
          )}
        >
          <Text className="font-mono-bold text-12 tracking-w14 text-bone">
            {closing ? 'CLOSING…' : 'CLOSE POSITION'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The middle of a ticket, the same on both layouts: the open position, or the
 * size and leverage to choose, and under either the order type and the slippage
 * bound, which hold for a close as much as for an open. Every figure here is
 * the server's. Until the account is read there are none, so it draws none.
 */
function TicketBody({
  ticket,
  dense,
  onClose,
}: {
  ticket: VenueTicket;
  dense: boolean;
  onClose?: (() => void) | undefined;
}) {
  const { view, locked, sending } = ticket;
  if (view.status === 'loading') {
    return (
      <View className="gap-2" aria-busy aria-label="Reading the trading account">
        <Skeleton height={dense ? 28 : 44} />
        <Skeleton height={dense ? 28 : 44} />
      </View>
    );
  }
  if (!view.limits) return null;
  const off = locked || view.hold !== null;
  return (
    <>
      {view.position ? (
        <PositionBlock
          position={view.position}
          dense={dense}
          onClose={onClose}
          closing={sending?.action === 'close'}
          locked={locked}
        />
      ) : (
        <>
          <ChoiceGroup label="Size" range={view.limits.size}>
            <ChoiceChips
              label="Order size"
              options={view.sizes}
              value={view.usd}
              format={formatUsd}
              describe={(usd) => `Size ${usd} dollars`}
              onChoose={ticket.chooseUsd}
              disabled={off}
              dense={dense}
            />
          </ChoiceGroup>
          <ChoiceGroup label="Leverage" range={view.limits.leverage}>
            <ChoiceChips
              label="Leverage"
              options={view.leverages}
              value={view.leverage}
              format={formatLeverage}
              describe={(leverage) => `Leverage ${formatLeverage(leverage)}`}
              onChoose={ticket.chooseLeverage}
              disabled={off}
              dense={dense}
            />
          </ChoiceGroup>
        </>
      )}
      <Facts
        rows={[
          ['Order type', view.limits.orderType],
          ['Max slippage', view.limits.slippage],
        ]}
        dense={dense}
      />
    </>
  );
}

/**
 * The secondary action, as the ticket always had it: put the market as it
 * stands to the pinned rule, which proposes the trade or refuses it. It places
 * nothing. The signal square is the rule's mark, as on the legend above the chart.
 */
function RuleCheck({
  onPress,
  busy,
  note,
  roomy,
}: {
  onPress: () => void;
  busy: boolean;
  /** Why the last check went nowhere, in the rule's own words. */
  note: string | null;
  /** 44px tall, for a thumb. */
  roomy?: boolean;
}) {
  return (
    <View className="gap-1.5">
      <Pressable
        role="button"
        aria-label="Check the market against the pinned rule. Nothing is placed."
        aria-busy={busy}
        disabled={busy}
        onPress={onPress}
        className={cx(
          'flex-row items-center justify-between gap-2 rounded-xs border border-hairline px-2.5 hover:bg-raised/60 active:bg-raised',
          roomy ? 'h-11' : 'h-8',
          busy && 'opacity-40',
        )}
      >
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <View className="size-1.75 shrink-0 bg-signal" />
          <Text numberOfLines={1} className="shrink font-sans text-12 text-bone">
            {busy ? 'Checking against the rule…' : 'Check against the rule'}
          </Text>
        </View>
        <Icon name="chevron-right" size={14} color="ash" />
      </Pressable>
      {note ? (
        <Num className="text-10 leading-4 text-ash">{note}</Num>
      ) : roomy ? (
        <Text className="font-sans text-11 leading-4 text-ash">
          The rule proposes the trade or refuses it. Nothing is placed by that check.
        </Text>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Recent orders                                                               */
/* -------------------------------------------------------------------------- */

interface OrdersProps {
  /** Rows carry the panel's 16px gutter. Off inside a sheet, which has its own. */
  inset: boolean;
  className?: string | undefined;
}

/**
 * The list is the one part of the ticket that subscribes to a query, and a
 * query the server cannot answer throws while it renders. A list that cannot be
 * read says so in its own place: it does not take the ticket, or the chart
 * beside it, down with it.
 */
class OrdersBoundary extends Component<OrdersProps & { children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { inset, className } = this.props;
    const pad = inset ? 'px-4' : '';
    return (
      <View {...(className ? { className } : {})}>
        <SectionHeader title="Recent orders" className={cx('pb-2.5', pad)} />
        <Text role="status" className={cx('pb-4 font-sans text-12 leading-[18px] text-ash', pad)}>
          The order list could not be read. Orders can still be placed.
        </Text>
      </View>
    );
  }
}

/**
 * The caller's own last few orders, each with what became of it and, for a
 * fill, its transaction. It subscribes itself, so the list exists only while it
 * is on screen. Every status is set the same neutral way; a refusal is one of
 * them, not a failure among them.
 */
export const RecentOrders = memo(function RecentOrders(props: OrdersProps) {
  return (
    <OrdersBoundary {...props}>
      <OrderList {...props} />
    </OrdersBoundary>
  );
});

function OrderList({ inset, className }: OrdersProps) {
  const orders = useVenueOrders();
  const now = useNowMs();
  const pad = inset ? 'px-4' : '';
  const rows = orders.status === 'ready' ? orders.orders.slice(0, RECENT_ORDERS) : [];
  return (
    <View {...(className ? { className } : {})}>
      <SectionHeader
        title="Recent orders"
        {...(rows.length > 0 ? { count: rows.length } : {})}
        className={cx('pb-2.5', pad)}
      />
      {orders.status === 'loading' ? (
        <View aria-busy aria-label="Loading recent orders">
          {[0, 1].map((i) => (
            <View key={i} className={cx('min-h-14 justify-center gap-1.5 border-b border-hairline py-3', pad)}>
              <Skeleton width="55%" height={12} />
              <Skeleton width="80%" height={10} />
            </View>
          ))}
        </View>
      ) : rows.length === 0 ? (
        <Text className={cx('pb-4 font-sans text-12 leading-[18px] text-ash', pad)}>
          No orders yet. Each one you send is listed here with what became of it.
        </Text>
      ) : (
        rows.map((order) => {
          const row = orderRowView(order, now);
          return (
            <View key={row.id} className={cx('min-h-14 gap-1 border-b border-hairline py-2.5', pad)}>
              <View className="flex-row items-center justify-between gap-2">
                <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
                  {row.side ? <SideGlyph side={row.side} size={12} /> : null}
                  <Text numberOfLines={1} className="shrink font-mono-medium text-12 text-bone">
                    {row.title}
                  </Text>
                </View>
                <Badge label={row.label} className="self-center" />
              </View>
              <Num className="text-11 leading-4 text-ash">{row.detail}</Num>
              <View className="flex-row items-center justify-between gap-2">
                {row.tx ? (
                  <TxLink tx={row.tx} />
                ) : (
                  <Text className="font-mono text-10 text-ash">{row.txMissing ? 'No transaction hash reported' : ''}</Text>
                )}
                <Num className="text-10 text-ash">{relativeTime(row.at, now)}</Num>
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Desktop                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ticket at the foot of the desktop panel. LONG and SHORT send a market
 * order for the asset on the chart at the size and leverage chosen above them,
 * and the answer is shown here, in place. The buttons stay put: if the panel is
 * short the part above them scrolls instead.
 */
export const OrderTicket = memo(function OrderTicket({
  ticket,
  onCheckRule,
  checking,
  note,
}: {
  ticket: VenueTicket;
  onCheckRule: () => void;
  checking: boolean;
  note: string | null;
}) {
  const { view, sending, locked } = ticket;
  const line = ticketLine(view, sending);
  const off = locked || view.hold !== null || view.usd === null || view.leverage === null;
  const label = (side: VenueSide) =>
    view.usd !== null && view.leverage !== null ? openOrderLabel(side, view.usd, view.leverage) : `Open ${side}`;
  return (
    <View className="min-h-0 shrink border-t border-hairline bg-void" aria-busy={sending !== null}>
      <ScrollView className="min-h-0" contentContainerClassName="gap-3 px-4 pt-4" showsVerticalScrollIndicator={false}>
        <View className="gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Label>Order · {baseOf(ticket.asset)}</Label>
            <RefreshButton ticket={ticket} />
          </View>
          <Text className="font-mono text-10 leading-4 text-ash">{view.venueLine}</Text>
        </View>
        {ticket.outcome ? <OutcomeBlock outcome={ticket.outcome} onDismiss={ticket.dismiss} /> : null}
        <TicketBody ticket={ticket} dense onClose={ticket.close} />
      </ScrollView>

      <View className="shrink-0 gap-2 px-4 pb-4 pt-3">
        <View className="flex-row gap-2">
          <DirectionButton side="long" label={label('long')} disabled={off} onPress={() => ticket.open('long')} />
          <DirectionButton side="short" label={label('short')} disabled={off} onPress={() => ticket.open('short')} />
        </View>
        <Text
          role="status"
          accessibilityLiveRegion="polite"
          className={cx('font-mono text-10 leading-4', line ? 'text-bone' : 'text-ash')}
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {line ?? 'A press sends a market order to one account that everyone signed in shares.'}
        </Text>
        <RuleCheck onPress={onCheckRule} busy={checking} note={note} />
      </View>
    </View>
  );
});

/* -------------------------------------------------------------------------- */
/* Phone and tablet                                                            */
/* -------------------------------------------------------------------------- */

/** LONG or SHORT, chosen in the sheet. Nothing is picked for anybody: the action waits for one. */
function SideChoice({
  side,
  onSide,
  disabled,
}: {
  side: VenueSide | null;
  onSide: (side: VenueSide) => void;
  disabled: boolean;
}) {
  const { select } = useHaptics();
  return (
    <View className="gap-1.5">
      <Label>Side</Label>
      <View role="radiogroup" aria-label="Order side" className="flex-row gap-2">
        {(['long', 'short'] as const).map((option) => {
          const on = option === side;
          const long = option === 'long';
          return (
            <Pressable
              key={option}
              role="radio"
              aria-checked={on}
              aria-label={long ? 'Long' : 'Short'}
              disabled={disabled}
              onPress={() => {
                if (on) return;
                select();
                onSide(option);
              }}
              className={cx(
                'h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xs border',
                on
                  ? long
                    ? 'border-long bg-long/15'
                    : 'border-short bg-short/15'
                  : 'border-hairline bg-panel active:bg-raised',
                disabled && 'opacity-40',
              )}
            >
              <SideGlyph side={option} />
              <Text
                className={cx(
                  'font-mono-bold text-12 tracking-w14',
                  on ? (long ? 'text-long' : 'text-short') : 'text-bone',
                )}
              >
                {SIDE_WORD[option]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The phone's ticket: a bottom sheet, opened from the bar. Side, size and
 * leverage are chosen here, beside the limits they are held to, and the one
 * action that sends anything is held at the foot, under the thumb. With a
 * position open that action closes it, since nothing else can be done first.
 */
export function TicketSheet({
  open,
  onClose,
  ticket,
  side,
  onSide,
  onCheckRule,
  checking,
  note,
}: {
  open: boolean;
  onClose: () => void;
  ticket: VenueTicket;
  /** The side tapped on the bar, or picked here. Null until one is. */
  side: VenueSide | null;
  onSide: (side: VenueSide) => void;
  onCheckRule: () => void;
  checking: boolean;
  note: string | null;
}) {
  const { tap } = useHaptics();
  const { view, sending, locked } = ticket;
  const primary = sheetPrimary(view, side, sending, locked);
  const line = ticketLine(view, sending);
  const press = () => {
    if (primary.action === 'close') ticket.close();
    else if (primary.action === 'open' && primary.side) ticket.open(primary.side);
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`ORDER · ${baseOf(ticket.asset)}`}
      meta={view.network ? `PERPL ${view.network.toUpperCase()}` : 'PERPL'}
      footer={
        <View className="gap-2.5">
          <Text
            role="status"
            accessibilityLiveRegion="polite"
            className={cx('font-mono text-11 leading-4', line ? 'text-bone' : 'text-ash')}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {line ??
              (view.limits
                ? `A market order fills within ${view.limits.slippage} of the mark price, or not at all.`
                : '')}
          </Text>
          <Pressable
            role="button"
            aria-label={primary.accessibilityLabel}
            aria-busy={sending !== null}
            disabled={primary.disabled}
            onPressIn={tap}
            onPress={press}
            className={cx(
              'h-14 flex-row items-center justify-center gap-2 rounded-sm border active:opacity-80',
              primary.side === 'long'
                ? 'border-long bg-long'
                : primary.side === 'short'
                  ? 'border-short bg-short'
                  : primary.action === 'close'
                    ? 'border-bone bg-transparent'
                    : 'border-hairline bg-panel',
              primary.disabled && 'opacity-40',
            )}
          >
            {primary.side ? <SideGlyph side={primary.side} size={16} onFill /> : null}
            <Text
              className={cx(
                'font-mono-bold text-13 tracking-w06',
                primary.side ? 'text-void' : primary.action === 'close' ? 'text-bone' : 'text-ash',
              )}
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {primary.label}
            </Text>
          </Pressable>
        </View>
      }
    >
      <View className="gap-5 pb-5" aria-busy={sending !== null}>
        <View className="flex-row items-start justify-between gap-3">
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-mono-medium text-12 text-bone">{view.venueLine}</Text>
            <Text className="font-sans text-12 leading-[18px] text-ash">
              {view.network === 'testnet'
                ? 'Everyone signed in trades this one account. It holds testnet funds, not yours.'
                : 'Everyone signed in trades this one account. Its funds are not yours.'}
            </Text>
          </View>
          <RefreshButton ticket={ticket} />
        </View>

        {ticket.outcome ? <OutcomeBlock outcome={ticket.outcome} onDismiss={ticket.dismiss} /> : null}
        {view.status === 'ready' && !view.position ? (
          <SideChoice side={side} onSide={onSide} disabled={locked || view.hold !== null} />
        ) : null}
        <TicketBody ticket={ticket} dense={false} />
        <RuleCheck onPress={onCheckRule} busy={checking} note={note} roomy />
        <RecentOrders inset={false} />
      </View>
    </BottomSheet>
  );
}
