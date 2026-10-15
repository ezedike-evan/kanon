import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import {
  FILL_OR_KILL_LINE,
  SLIPPAGE_CHOICES_BPS,
  approvalLine,
  chainName,
  depthLine,
  floorToDecimals,
  formatSpotAmount,
  mintLabel,
  orderFacts,
  sizeLimits,
  spotAddress,
  tokenLine,
  type SpotMarket,
  type SpotMintNote,
  type SpotOutcomeView,
} from '../../lib/spot';
import type { SpotTicket } from '../../lib/use-spot-ticket';
import { useHaptics } from '../../platform';
import { useTheme } from '../../theme';
import { BottomSheet } from '../bottom-sheet';
import { Card } from '../card';
import { FiguredText } from '../figured-text';
import { Icon } from '../icons';
import { ChoiceChips, FOCUS, Facts, TxInline, TxLink } from '../reel/trade-parts';
import { SegmentedControl } from '../segmented-control';
import { SignInLink } from '../sign-in-link';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { GhostButton, Num, PrimaryButton } from '../ui';
import { AddressRow } from './spot-book';

/*
 * The spot ticket: what the person chooses on the screen, the one action at
 * the foot that opens the confirmation, and the confirmation itself, a bottom
 * sheet that states everything that will be sent before one press sends it.
 *
 * Nothing here decides anything. Whether an order can be sent, what it is in
 * the contract's units and what every sentence says come from `useSpotTicket`
 * and `spot.ts`. An answer is set the same neutral way whatever it says: a
 * fill-or-kill order that reverted is the bound doing its job, and it takes no
 * alarm colour and no warning glyph.
 */

const SIDES = [
  { value: 'buy', label: 'Buy', icon: 'arrow-up' },
  { value: 'sell', label: 'Sell', icon: 'arrow-down' },
] as const;

/** The amount, with its label above it and the sizes the market takes below. A buy is typed in the quote token, a sell in the base. */
function AmountField({ ticket, market }: { ticket: SpotTicket; market: SpotMarket }) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const buying = ticket.side === 'buy';
  const token = buying ? market.quote : market.base;
  const label = buying ? `Amount of ${token.symbol} to spend` : `Amount of ${token.symbol} to sell`;
  return (
    <View className="gap-2">
      <Text className="font-mono text-11 text-ash">{label}</Text>
      <View className={cx('flex-row items-center rounded-sm border bg-raised px-3.5', focused ? 'border-verified' : 'border-hairline')}>
        <TextInput
          value={ticket.amount}
          onChangeText={ticket.setAmount}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="0"
          placeholderTextColor={colors.ash}
          cursorColor={colors.signal}
          selectionColor={colors.signal}
          keyboardType="decimal-pad"
          autoCapitalize="none"
          autoCorrect={false}
          aria-label={label}
          className="min-w-0 flex-1 py-3 font-mono text-18 text-bone"
          style={{ fontVariant: ['tabular-nums'] }}
        />
        <Text className="pl-3 font-mono-medium text-12 text-ash">{token.symbol}</Text>
      </View>
      <Num className="text-11 leading-4 text-ash">{`The market takes orders from ${sizeLimits(market)}.`}</Num>
    </View>
  );
}

/** What the signing wallet holds: both tokens, the coin that pays for gas, and the wallet itself on the explorer. */
function Balances({ ticket, market }: { ticket: SpotTicket; market: SpotMarket }) {
  const { wallet } = ticket;
  if (!wallet) {
    if (!ticket.walletLoading) return null;
    return (
      <View aria-busy aria-label="Reading the wallet" className="rounded-sm border border-hairline bg-panel">
        {[0, 1, 2].map((i) => (
          <View key={i} className={cx('min-h-9 flex-row items-center justify-between px-3.5', i < 2 && 'border-b border-hairline')}>
            <Skeleton width={112} height={10} />
            <Skeleton width={64} height={10} />
          </View>
        ))}
      </View>
    );
  }
  const rows: Array<readonly [string, string]> = [
    [`${market.quote.name} in wallet`, formatSpotAmount(wallet.quote, market.quote.symbol)],
    [`${market.base.name} in wallet`, formatSpotAmount(wallet.base, market.base.symbol)],
    ['For gas', formatSpotAmount(floorToDecimals(wallet.native, 4), wallet.nativeSymbol)],
  ];
  return (
    <View className="gap-2">
      <Facts rows={rows} />
      <View className="rounded-sm border border-hairline bg-panel">
        <AddressRow label="Your wallet" address={wallet.address} link={spotAddress(market.chainId, wallet.address)} last />
      </View>
    </View>
  );
}

function MintNote({ note }: { note: SpotMintNote }) {
  return (
    <View role="status" accessibilityLiveRegion="polite" className="gap-1.5">
      <FiguredText text={note.line} className="font-sans text-12 leading-[18px] text-bone" />
      {note.links.map((link) => (
        <TxInline key={link.tx.hash} tx={link.tx} name={link.name} />
      ))}
    </View>
  );
}

/** The open mint: how a tester gets something to trade with. Said plainly to be test money. */
function MintAction({ ticket, market }: { ticket: SpotTicket; market: SpotMarket }) {
  const { tap } = useHaptics();
  const label = mintLabel(market);
  return (
    <View className="gap-2">
      <Pressable
        role="button"
        aria-label={label}
        aria-busy={ticket.minting}
        disabled={!ticket.canMint}
        onPressIn={tap}
        onPress={ticket.mint}
        className={cx(
          'h-11 flex-row items-center justify-center gap-2 rounded-sm border border-hairline bg-raised hover:bg-raised active:opacity-80',
          !ticket.canMint && 'opacity-40',
          FOCUS,
        )}
      >
        <Icon name="coins" size={16} color="bone" />
        <Num className="font-mono-medium text-12 uppercase tracking-w10">{ticket.minting ? 'Minting' : label}</Num>
      </Pressable>
      <Text className="font-sans text-12 leading-[18px] text-ash">
        {`Test money from ${market.quote.name}'s open mint. Anyone can mint it and it has no value.`}
      </Text>
      {ticket.mintNote ? <MintNote note={ticket.mintNote} /> : null}
    </View>
  );
}

/**
 * The answer to an order, in place: a neutral title, its figures, its one
 * sentence, and each transaction on the explorer. No money made or lost is
 * stated anywhere in it: a fill is a size and a price.
 */
export function SpotOutcome({ outcome, onDismiss }: { outcome: SpotOutcomeView; onDismiss?: (() => void) | undefined }) {
  return (
    <View role="status" accessibilityLiveRegion="polite" className="gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          <Icon name={outcome.mark === 'done' ? 'check-circle' : 'info'} size={16} color={outcome.mark === 'done' ? 'bone' : 'ash'} />
          <Text className="font-mono-bold text-12 tracking-w14 text-bone">{outcome.title}</Text>
        </View>
        {onDismiss ? (
          <Pressable role="button" aria-label="Dismiss" hitSlop={10} onPress={onDismiss} className={cx('rounded-xs p-1 active:opacity-70', FOCUS)}>
            <Icon name="x" size={16} color="ash" />
          </Pressable>
        ) : null}
      </View>
      {outcome.facts.length > 0 ? <Facts rows={outcome.facts} /> : null}
      {outcome.line ? <FiguredText text={outcome.line} className="font-sans text-13 leading-5 text-bone" /> : null}
      {outcome.links.length > 0 ? (
        <View className="rounded-sm border border-hairline bg-panel">
          {outcome.links.map((link, i) => (
            <View key={link.tx.hash} className={cx(i < outcome.links.length - 1 && 'border-b border-hairline')}>
              <TxLink tx={link.tx} name={link.name} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The ticket on the screen: the side, the amount, what the wallet holds and
 * the open mint. Signed out it is the way to sign in, and the book above it is
 * still the book. The last order's answer stays here after the sheet is closed.
 */
export function TicketCard({ ticket, market }: { ticket: SpotTicket; market: SpotMarket }) {
  if (ticket.gate?.kind === 'sign_in') {
    return (
      <Card pad="md" className="gap-3">
        <Text className="font-sans text-13 leading-5 text-ash">
          The book is public. An order is sent from your own wallet, so trading needs an account.
        </Text>
        <SignInLink className="self-start py-1" />
      </Card>
    );
  }
  return (
    <Card pad="md" className="gap-4">
      <SegmentedControl label="Side" options={SIDES} value={ticket.side} onChange={ticket.chooseSide} />
      <AmountField ticket={ticket} market={market} />
      <Balances ticket={ticket} market={market} />
      <MintAction ticket={ticket} market={market} />
      {ticket.outcome ? (
        <View className="border-t border-hairline pt-4">
          <SpotOutcome outcome={ticket.outcome} onDismiss={ticket.dismiss} />
        </View>
      ) : null}
    </Card>
  );
}

/**
 * The foot of the screen: one line saying what the order is or why there is
 * none, and the one action, which opens the confirmation. Signed out it is the
 * way to sign in, always in reach, and there is no other action to offer.
 */
export function ActionBar({ ticket, onReview }: { ticket: SpotTicket; onReview: () => void }) {
  const { gate, line } = ticket;
  if (!gate) return null;
  if (gate.kind === 'sign_in') {
    return (
      <View className="shrink-0 border-t border-hairline bg-void px-5 py-3.5">
        <SignInLink className="self-start" />
      </View>
    );
  }
  const stated = Boolean(ticket.sizing?.ok) || ticket.sending !== null;
  return (
    // A phone stacks the line over a full-width action. From `lg` the pane is wide, so the line
    // takes the left and the action keeps a button's width on the right instead of spanning it.
    <View
      className={cx(
        'shrink-0 gap-2.5 border-t border-hairline bg-void px-5 pb-3 pt-3',
        web('lg:flex-row lg:items-center lg:justify-between lg:gap-6'),
      )}
    >
      {line ? (
        <Text
          role="status"
          accessibilityLiveRegion="polite"
          className={cx('font-mono text-11 leading-4', stated ? 'text-bone' : 'text-ash', web('lg:min-w-0 lg:flex-1'))}
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {line}
        </Text>
      ) : null}
      <View className={web('lg:ml-auto lg:w-[320px]')}>
        <PrimaryButton onPress={onReview} disabled={!ticket.canSend}>
          {ticket.side === 'buy' ? 'REVIEW BUY' : 'REVIEW SELL'}
        </PrimaryButton>
      </View>
    </View>
  );
}

/**
 * The confirmation, as a bottom sheet. It states exactly what will be sent:
 * the side, the amount, the best price, the taker fee, the slippage bound, the
 * least that will be accepted, and how many transactions the wallet will be
 * asked for. The bound is changed here, where the least received moves with it.
 * One press on the action at its foot sends the order as stated at that moment.
 */
export function OrderSheet({
  open,
  onClose,
  ticket,
  market,
}: {
  open: boolean;
  onClose: () => void;
  ticket: SpotTicket;
  market: SpotMarket;
}) {
  const { tap } = useHaptics();
  const { sizing, sending, outcome } = ticket;
  const order = sizing?.ok ? sizing.order : null;
  const buying = ticket.side === 'buy';
  const depth = order ? depthLine(order) : null;
  // The foot restates the order, or says where it has got to. With no order (after a fill the amount
  // is cleared; or the book moved and it no longer sizes) the body says what there is to say.
  const status = order || sending ? ticket.line : null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`${buying ? 'BUY' : 'SELL'} ${market.base.symbol}`}
      meta="KURU TESTNET"
      footer={
        <View className="gap-2.5">
          {status ? (
            <Text
              role="status"
              accessibilityLiveRegion="polite"
              className="font-mono text-11 leading-4 text-bone"
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {status}
            </Text>
          ) : null}
          {order ? (
            <Pressable
              role="button"
              aria-label={buying ? `Send the buy order for ${market.base.symbol}` : `Send the sell order for ${market.base.symbol}`}
              aria-busy={sending !== null}
              disabled={!ticket.canSend}
              onPressIn={tap}
              onPress={ticket.send}
              className={cx(
                'h-14 flex-row items-center justify-center gap-2 rounded-sm border active:opacity-80',
                buying ? 'border-long bg-long' : 'border-short bg-short',
                !ticket.canSend && 'opacity-40',
              )}
            >
              <Icon name={buying ? 'arrow-up' : 'arrow-down'} size={16} color="void" strokeWidth={2} />
              <Text className="font-mono-bold text-13 tracking-w06 text-void">
                {sending ? 'SENDING' : buying ? `BUY ${market.base.symbol}` : `SELL ${market.base.symbol}`}
              </Text>
            </Pressable>
          ) : (
            <GhostButton onPress={onClose}>{outcome ? 'DONE' : 'CLOSE'}</GhostButton>
          )}
        </View>
      }
    >
      <View className="gap-4 pb-5" aria-busy={sending !== null}>
        {outcome ? <SpotOutcome outcome={outcome} /> : null}
        {order ? (
          <>
            <Text className="font-sans text-12 leading-[18px] text-ash">
              {`A market order on Kuru's order book on ${chainName(market.chainId)}, sent from your own wallet. ${tokenLine(market.base)}`}
            </Text>
            <Facts rows={orderFacts(order, market, ticket.needsApproval)} />
            <View className="gap-2">
              <Label>Slippage bound</Label>
              <ChoiceChips
                label="Slippage bound"
                options={SLIPPAGE_CHOICES_BPS}
                value={ticket.slippageBps}
                format={(bps) => formatBps(bps)}
                describe={(bps) => `Slippage bound ${formatBps(bps)}`}
                onChoose={ticket.chooseSlippage}
                disabled={sending !== null}
              />
              <Text className="font-sans text-12 leading-[18px] text-ash">
                The least you will accept moves with the bound. A tighter one reverts more often.
              </Text>
            </View>
            <View className="gap-1.5">
              <Text className="font-sans text-12 leading-[18px] text-ash">{FILL_OR_KILL_LINE}</Text>
              {ticket.needsApproval ? (
                <FiguredText text={approvalLine(order)} className="font-sans text-12 leading-[18px] text-ash" />
              ) : null}
              {depth ? <Text className="font-sans text-12 leading-[18px] text-bone">{depth}</Text> : null}
            </View>
          </>
        ) : outcome || !ticket.line ? null : (
          <Text className="font-sans text-13 leading-5 text-ash">{ticket.line}</Text>
        )}
      </View>
    </BottomSheet>
  );
}
