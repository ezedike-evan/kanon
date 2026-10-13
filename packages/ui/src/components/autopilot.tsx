import { memo, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  AUTOPILOT_SIGN_IN,
  OPENED_BY_AUTOPILOT,
  REPLACED_STILL_ON,
  RULE_SIZING_NOTE,
  TERMS_UNREADABLE,
  autopilotOffer,
  autopilotSummary,
  autopilotTerms,
  autopilotVenueTerms,
  type AutopilotNote,
  type AutopilotState,
  type AutopilotSubject,
} from '../lib/autopilot';
import { cx } from '../lib/cx';
import { useKanonSelector } from '../lib/data';
import { useTimedState } from '../lib/domains';
import { timedTradeRoute, tradeRoute } from '../lib/routes';
import { shallowEqual } from '../lib/store';
import { Link } from '../nav';
import { useHaptics } from '../platform';
import { Badge } from './badge';
import { BottomSheet } from './bottom-sheet';
import { Chip } from './chip';
import { FiguredText } from './figured-text';
import { Icon, type Icon as IconName } from './icons';
import { FOCUS, Facts } from './reel/trade-parts';
import { SignInLink } from './sign-in-link';
import { Skeleton } from './skeleton';
import { Label } from './stat';
import type { Tone } from './tone';
import { GhostButton, Meta, Num, PrimaryButton } from './ui';

/*
 * Autopilot, wherever it is drawn: the switch on a rule's card, the sheet that
 * says what it does before it is turned on, and the mark a trade, a proposal or
 * a refusal carries when the rule was judged at a candle close with nobody
 * pressing anything.
 *
 * Three things hold in all of it. Nothing is turned on from a row: the row opens
 * the terms, and the action is at the foot of them. No parameter is hidden: the
 * stake, the hold, the limit of one trade and what turning it off withdraws are
 * read before the switch is thrown. And a setup that was refused or not opened
 * is the rule and its limits working: its own mark, no error styling, no apology.
 */

/* -------------------------------------------------------------------------- */
/* The mark                                                                    */
/* -------------------------------------------------------------------------- */

/** `BY AUTOPILOT`, with its glyph: who put the setup to the rule. Never colour alone. */
export function AutopilotMark({ label = 'By autopilot', className }: { label?: string; className?: string | undefined }) {
  return (
    <View className={cx('shrink-0 flex-row items-center gap-1', className)}>
      <Icon name="bot" size={12} color="signal" strokeWidth={2} />
      <Text className="font-mono-bold text-10 uppercase tracking-w10 text-signal">{label}</Text>
    </View>
  );
}

/**
 * The mark on a timed trade autopilot opened, as the way to its evidence: the
 * proposal the rule passed, with every predicate and the number that decided it.
 * One press, from wherever the trade is listed.
 */
export function AutopilotEvidenceLink({ proposalId, className }: { proposalId: string; className?: string | undefined }) {
  const { tap } = useHaptics();
  return (
    <Link
      href={tradeRoute(proposalId)}
      aria-label="Opened by autopilot. Open the proposal that is its evidence."
      hitSlop={8}
      onPressIn={tap}
      className={cx('flex-row items-center gap-1.5 self-start rounded-xs py-0.5 hover:opacity-80 active:opacity-70', FOCUS, className)}
    >
      <AutopilotMark />
      <Text className="font-mono-medium text-10 uppercase tracking-w08 text-verified">Evidence</Text>
      <Icon name="chevron-right" size={12} color="verified" strokeWidth={2} />
    </Link>
  );
}

/**
 * The same evidence as a ruled row, for a sheet that already lists a trade's
 * transactions: what opened it in a sentence, and the proposal one press away.
 */
export function AutopilotEvidenceRow({ proposalId }: { proposalId: string | null }) {
  const { tap } = useHaptics();
  return (
    <View className="rounded-sm border border-hairline bg-panel">
      <View className="gap-1.5 px-3.5 py-3">
        <AutopilotMark />
        <Text className="font-sans text-13 leading-5 text-bone">{OPENED_BY_AUTOPILOT}</Text>
      </View>
      {proposalId ? (
        <Link
          href={tradeRoute(proposalId)}
          aria-label="Open the proposal that is this trade's evidence"
          onPressIn={tap}
          className={cx(
            'min-h-11 flex-row items-center justify-between gap-3 border-t border-hairline px-3.5 hover:bg-raised/60 active:bg-raised',
            FOCUS,
          )}
        >
          <Text className="font-mono text-12 text-ash">The rule's verdict</Text>
          <View className="flex-row items-center gap-1.5">
            <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">Proposal</Text>
            <Icon name="arrow-right" size={14} color="verified" />
          </View>
        </Link>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* What autopilot did with one setup                                            */
/* -------------------------------------------------------------------------- */

/** A state's badge. A refusal keeps the block's own mark; waiting is the rule's amber; the rest are neutral. */
const STATE_BADGE: Record<AutopilotState, { tone: Tone; icon: IconName }> = {
  refused: { tone: 'refused', icon: 'ban' },
  waiting: { tone: 'signal', icon: 'clock' },
  opened: { tone: 'neutral', icon: 'check' },
  // Nothing was opened: the limits doing their job, set the way any other answer is.
  not_opened: { tone: 'neutral', icon: 'minus' },
};

/**
 * What autopilot did with a setup, on the screen that is its evidence: where it
 * stands, what the gateway was asked to open, the way to the timed trade when
 * one was opened, and the reason in the server's own words when one was not.
 */
export function AutopilotBlock({
  note,
  link = true,
  className,
}: {
  note: AutopilotNote;
  /** Draw the way to the timed trade here. False where the screen anchors that link at its foot. */
  link?: boolean | undefined;
  className?: string | undefined;
}) {
  const { tap } = useHaptics();
  const badge = STATE_BADGE[note.state];
  return (
    <View className={cx('border border-hairline bg-panel', className)}>
      <View className="flex-row items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
        <AutopilotMark />
        <Badge label={note.label} tone={badge.tone} icon={badge.icon} className="self-center" />
      </View>
      <View className="gap-2 px-4 py-3">
        <FiguredText text={note.line} className="font-sans text-13 leading-5 text-bone" />
        {/* The server's sentence, unchanged. */}
        {note.reason ? <Num className="text-12 leading-[18px] text-ash">{note.reason}</Num> : null}
      </View>
      {note.sent ? (
        <View className="flex-row items-center justify-between gap-3 border-t border-hairline bg-raised px-4 py-2.5">
          <Meta>STAKE · HOLD</Meta>
          <Num className="font-mono-medium text-13">{note.sent}</Num>
        </View>
      ) : null}
      {link && note.timedTradeId ? (
        <Link
          href={timedTradeRoute(note.timedTradeId)}
          aria-label="Open the timed trade that was opened for this proposal"
          onPressIn={tap}
          className={cx(
            'min-h-11 flex-row items-center justify-between gap-3 border-t border-hairline px-4 hover:bg-raised/60 active:bg-raised',
            FOCUS,
          )}
        >
          {/* Short enough for a 390px row, and allowed to wrap rather than push its arrow out. */}
          <Text className="min-w-0 flex-1 font-mono text-12 tracking-w04 text-verified">Timed trade: the real fill</Text>
          <Icon name="arrow-right" size={14} color="verified" />
        </Link>
      ) : null}
      {note.state === 'refused' ? null : (
        <Text className="border-t border-hairline px-4 py-2.5 font-sans text-12 leading-[18px] text-ash">{RULE_SIZING_NOTE}</Text>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The switch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Autopilot on a rule's card: whether it is on, what it does in one line, and
 * the way to its terms. A press opens the sheet. It turns nothing on by itself.
 */
export const AutopilotRow = memo(function AutopilotRow({
  on,
  candleSeconds,
  replaced,
  onPress,
  className,
}: {
  on: boolean;
  /** Seconds one candle of the rule lasts, or null when its stored spec no longer parses. */
  candleSeconds: number | null;
  /** The rule was replaced by a newer one and autopilot is still on for it. */
  replaced?: boolean | undefined;
  onPress: () => void;
  className?: string | undefined;
}) {
  const { tap } = useHaptics();
  const summary = replaced ? REPLACED_STILL_ON : candleSeconds === null ? TERMS_UNREADABLE : autopilotSummary(candleSeconds, on);
  return (
    <Pressable
      role="button"
      aria-label={`Autopilot is ${on ? 'on' : 'off'}. ${summary} Open its terms.`}
      onPressIn={tap}
      onPress={onPress}
      className={cx('min-h-14 flex-row items-center gap-3 px-4 py-3 hover:bg-raised active:bg-raised', FOCUS, className)}
    >
      <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-raised">
        <Icon name="bot" size={16} color={on ? 'signal' : 'ash'} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="font-mono-medium text-12 uppercase tracking-w10 text-bone">Autopilot</Text>
          <Badge label={on ? 'On' : 'Off'} tone={on ? 'signal' : 'neutral'} className="self-center" />
        </View>
        <FiguredText text={summary} className="font-sans text-12 leading-[17px] text-ash" />
      </View>
      <Icon name="chevron-right" size={16} color="ash" />
    </Pressable>
  );
});

/**
 * The two terms that are the venue's own, read from what Predict was last told
 * and only while the sheet is open: the size the stake opens, and the slippage
 * bound. Until they are read it is the shape of the two rows; where they cannot
 * be read, or the venue would not open the trade as things stand, it says so.
 */
function VenueTerms({ asset, holdSeconds }: { asset: string | null; holdSeconds: number }) {
  const { state } = useTimedState();
  const terms = autopilotVenueTerms(state, asset, holdSeconds);
  return (
    <View className="gap-2">
      <Label>The venue's own terms</Label>
      {terms.status === 'known' ? (
        <Facts rows={terms.facts} />
      ) : terms.status === 'loading' ? (
        <View aria-busy aria-label="Reading the venue's terms" className="rounded-sm border border-hairline bg-panel">
          {[0, 1].map((i) => (
            <View key={i} className={cx('min-h-9 flex-row items-center justify-between gap-3 px-3.5 py-2', i === 0 && 'border-b border-hairline')}>
              <Skeleton width={88} height={10} />
              <Skeleton width={120} height={10} />
            </View>
          ))}
        </View>
      ) : (
        <FiguredText text={terms.note} className="font-sans text-12 leading-[18px] text-ash" />
      )}
    </View>
  );
}

/**
 * What autopilot will do for one rule, read before it is turned on, with the
 * switch at the foot. A bottom sheet over the screen it was asked from.
 *
 * Signed out it is the same terms and no switch: nobody pinned a demo rule, so
 * the foot is the way to sign in. A switch that was not thrown says so in one
 * calm sentence above the action, and the sheet stays open on it.
 */
export function AutopilotSheet({ subject, onClose }: { subject: AutopilotSubject | null; onClose: () => void }) {
  const setAutopilot = useKanonSelector((s) => s.setAutopilot);
  const live = useKanonSelector((s) => s.mode === 'live');
  const { success, tap } = useHaptics();
  /** The side the switch is being thrown to while the request is out, or null. */
  const [sending, setSending] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A sheet opened on another rule, or reopened, starts with nothing said.
  const id = subject?.id ?? null;
  useEffect(() => {
    setSending(null);
    setNote(null);
  }, [id]);

  if (!subject) return null;
  const { on, offer } = subject;
  const terms = subject.candleSeconds === null ? null : autopilotTerms(subject.candleSeconds);

  const busy = sending !== null;
  // While a request is out the action stays the one that was pressed, whatever the row says meanwhile:
  // the strategy's own row can land before the mutation's answer does.
  const turningOff = sending === null ? on : !sending;

  async function throwSwitch(next: boolean) {
    if (busy || !subject) return;
    setSending(next);
    setNote(null);
    const out = await setAutopilot(subject.id, next);
    setSending(null);
    if (!out.ok) {
      setNote(out.message);
      return;
    }
    if (out.on) success();
    else tap();
    onClose();
  }

  const action = !live ? (
    <View className="min-h-11 items-center justify-center">
      <SignInLink lead={AUTOPILOT_SIGN_IN} />
    </View>
  ) : offer === 'none' ? null : turningOff ? (
    <GhostButton onPress={() => void throwSwitch(false)} disabled={busy}>
      {busy ? 'TURNING OFF' : 'TURN AUTOPILOT OFF'}
    </GhostButton>
  ) : (
    <PrimaryButton onPress={() => void throwSwitch(true)} disabled={busy}>
      {busy ? 'TURNING ON' : 'TURN AUTOPILOT ON'}
    </PrimaryButton>
  );

  const footer =
    action || note ? (
      <View className="gap-2.5" aria-busy={busy}>
        {note ? (
          <Text accessibilityLiveRegion="polite" className="font-sans text-12 leading-[18px] text-bone">
            {note}
          </Text>
        ) : null}
        {action}
      </View>
    ) : undefined;

  return (
    // No state beside the sheet's own CLOSE, where `ON` would read as part of it: the badge below says it.
    <BottomSheet open onClose={onClose} title="AUTOPILOT" footer={footer}>
      <View className="gap-4 pb-5">
        <View className="gap-2.5">
          <View className="flex-row flex-wrap items-center gap-2">
            <Num className="text-11 tracking-w10 text-signal">{subject.ordinal}</Num>
            {subject.asset ? <Chip label={subject.asset} /> : null}
            <Badge label={on ? 'On' : 'Off'} tone={on ? 'signal' : 'neutral'} icon="bot" size="md" className="self-center" />
          </View>
          <FiguredText
            text={terms ? terms.summary : TERMS_UNREADABLE}
            className="font-sans text-15 leading-[22px] text-bone"
          />
          {subject.replaced && on ? (
            <Text className="font-sans text-13 leading-5 text-ash">{REPLACED_STILL_ON}</Text>
          ) : null}
        </View>

        {terms ? (
          <>
            <Facts rows={terms.facts} />
            <VenueTerms asset={subject.asset} holdSeconds={terms.holdSeconds} />
            <View className="gap-2">
              {terms.notes.map((line) => (
                <View key={line} className="flex-row gap-2.5">
                  <View className="mt-2 h-px w-2 shrink-0 bg-ash" />
                  <FiguredText text={line} className="min-w-0 flex-1 font-sans text-12 leading-[18px] text-ash" />
                </View>
              ))}
            </View>
          </>
        ) : null}
      </View>
    </BottomSheet>
  );
}

/**
 * The sheet for the rule in force, as Home asks for it: the subject is read
 * from the source, so the switch shows what the server says it is.
 */
export function ActiveRuleAutopilotSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rule = useKanonSelector(
    (s) => ({
      id: s.rule.id,
      ordinal: s.rule.ordinal,
      asset: s.rule.symbol,
      candleSeconds: s.rule.bucketSeconds,
      on: s.rule.autopilot,
      pinned: s.hasPinned,
      cooling: s.coolingOff !== null,
    }),
    shallowEqual,
  );
  const subject: AutopilotSubject | null =
    open && rule.pinned
      ? {
          id: rule.id,
          ordinal: rule.ordinal,
          asset: rule.asset,
          candleSeconds: rule.candleSeconds,
          on: rule.on,
          offer: autopilotOffer(rule.cooling ? 'cooling_off' : 'pinned', rule.on),
          // The rule in force is by definition the newest one pinned.
          replaced: false,
        }
      : null;
  return <AutopilotSheet subject={subject} onClose={onClose} />;
}
