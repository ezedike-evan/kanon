import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { formatBps, formatDecimal, type Decimal } from '@kanon/spec';
import { Body, BrandBar, Footer, NavBar, Screen, StatusBar } from '../components/chrome';
import { UndoCountdown } from '../components/countdown';
import { DangerButton, Dot, GhostButton, Meta, Num, Panel, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { useKanonData } from '../lib/data';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

/**
 * 05 · TRADE PROPOSAL · UNDO WINDOW.
 *
 * The setup satisfied the spec, so it executes. Each predicate is shown beside
 * the arithmetic that satisfied it — the same comparison the contract made, in
 * the same direction, with the same numbers.
 *
 * The undo window is enforced on the server clock, not this countdown: the
 * countdown only shows it. Cancelling after the window has closed is refused
 * there, and this screen says so.
 */
export function ProposalScreen() {
  const nav = useNavigator();
  const { proposal: PROPOSAL, rule: RULE, undoProposal, confirmProposal, requestProposal, mode } =
    useKanonData();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // The window is read off its expiry, so a screen opened a moment late still shows what is left.
  const expiry = PROPOSAL?.undoExpiresAt;
  const fallbackSeconds = PROPOSAL?.undoSeconds ?? 0;
  const secondsLeft = useMemo(
    () =>
      expiry !== undefined
        ? Math.max(0, Math.ceil((expiry - Date.now()) / 1000))
        : fallbackSeconds,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [PROPOSAL?.tradeId, expiry],
  );

  if (!PROPOSAL) {
    return (
      <Screen rail="bg-hairline" label="05 · TRADE PROPOSAL · UNDO WINDOW">
        <NavBar left="PROPOSAL" leftHref={routes.home} right="NONE" />
        <Body contentClassName="justify-center">
          <Meta className="tracking-w20">NO SETUP PROPOSED</Meta>
          <Text className="mt-3 font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
            Nothing has been put to your rule yet.
          </Text>
          <Text className="mt-3.5 font-sans text-14 text-ash leading-[1.5]">
            Check the market as it stands. It is proposed if every predicate holds, and refused with the
            number that decided it if one does not.
          </Text>
          {note ? <Text className="mt-4 font-mono text-11 text-ash leading-[1.5]">{note}</Text> : null}
        </Body>
        <Footer>
          <PrimaryButton
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              setNote(null);
              const out = await requestProposal();
              setBusy(false);
              if (out.status === 'refused') nav.replace(routes.refused);
              else if (out.status !== 'proposed') setNote(out.message);
            }}
          >
            {busy ? 'CHECKING' : 'CHECK SETUP NOW'}
          </PrimaryButton>
        </Footer>
      </Screen>
    );
  }

  const open = PROPOSAL.status === 'proposed';
  const long = PROPOSAL.direction === 'long';
  const rows: Array<[string, Decimal]> = [
    ['ENTRY', PROPOSAL.entry],
    ['STOP', PROPOSAL.stop],
  ];
  if (PROPOSAL.target) rows.push(['TARGET', PROPOSAL.target]);

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const out = await undoProposal();
    setBusy(false);
    if (out.ok) nav.replace(routes.home);
    else setNote('The undo window has closed. The trade executes.');
  }

  async function executeNow() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const out = await confirmProposal();
    setBusy(false);
    if (!out.ok) setNote('This trade can no longer be executed from here.');
  }

  return (
    <Screen
      rail={PROPOSAL.status === 'undone' ? 'bg-hairline' : 'bg-long'}
      label="05 · TRADE PROPOSAL · UNDO WINDOW"
    >
      <StatusBar />
      <BrandBar
        status={`${RULE.ordinal} SATISFIED`}
        dot={PROPOSAL.status === 'undone' ? 'bg-ash' : 'bg-long'}
      />

      <Body>
        <View className="mt-7.5 flex-row items-center gap-2.25">
          <Dot size="size-2" className={PROPOSAL.status === 'undone' ? 'bg-ash' : 'bg-long'} />
          <Text
            className={cx(
              'font-mono-bold text-11 tracking-w20',
              PROPOSAL.status === 'undone' ? 'text-ash' : 'text-long',
            )}
          >
            {PROPOSAL.status === 'proposed'
              ? 'SETUP VALID · EXECUTING'
              : PROPOSAL.status === 'executed'
                ? PROPOSAL.paper
                  ? 'SETUP VALID · EXECUTED (PAPER)'
                  : 'SETUP VALID · EXECUTED'
                : 'SETUP VALID · UNDONE BY YOU'}
          </Text>
        </View>
        <Text className="mt-3.5 font-sans text-30 font-medium tracking-t25 text-bone leading-[1.08]">
          {long ? 'Long' : 'Short'} {RULE.asset.replace(/ /g, '')}
        </Text>

        <Panel className="mt-6">
          {rows.map(([label, value]) => (
            <View
              key={label}
              className="flex-row items-end justify-between border-b border-hairline px-4 py-3.25"
            >
              <Meta>{label}</Meta>
              <Num className="font-mono-medium text-26 tracking-t30">
                {formatDecimal(value)}
              </Num>
            </View>
          ))}
          <View className="flex-row gap-5 bg-raised px-4 py-3">
            <View className="flex-1 gap-1.5">
              <Meta>SIZE</Meta>
              <Num className="font-mono-medium text-15">
                {formatDecimal(PROPOSAL.size)} {PROPOSAL.sizeUnit}
              </Num>
            </View>
            <View className="flex-1 items-end gap-1.5">
              <Meta>RISK / ACCOUNT</Meta>
              <Num className="font-mono-medium text-15">
                {formatBps(PROPOSAL.riskBps)}
              </Num>
            </View>
          </View>
        </Panel>
        {/* Sizing states its base: equity is never assumed silently. */}
        <Text className="mt-2.5 font-mono text-10 tracking-w08 text-ash">
          SIZED ON {PROPOSAL.sizing}
          {PROPOSAL.target ? '' : ' · NO TARGET IN THE SPEC'}
        </Text>

        <View className="mt-5.5 mb-5">
          <Meta className="pb-2.5 tracking-w20">
            PREDICATES SATISFIED · {PROPOSAL.checks.length} / {PROPOSAL.checks.length}
          </Meta>
          {PROPOSAL.checks.map((check, i) => (
            <View
              key={check.label}
              className={cx(
                'flex-row items-center justify-between gap-3 border-t border-hairline py-2.75',
                i === PROPOSAL.checks.length - 1 && 'border-b',
              )}
            >
              <View className="flex-row items-center gap-2.5">
                {/* Green is load-bearing here, so it is paired with a glyph. */}
                <Text className="font-mono text-12 text-long" aria-hidden>
                  ✓
                </Text>
                <Text className="font-mono text-12 text-bone">{check.label}</Text>
              </View>
              <Num className="text-12 text-ash">{check.evidence}</Num>
            </View>
          ))}
        </View>
      </Body>

      <Footer>
        {open ? (
          <>
            <View className="mb-4 flex-row items-end justify-between border-t border-hairline py-4">
              <View className="gap-1.75">
                <Meta>UNDO WINDOW</Meta>
                <Text className="font-mono text-10 tracking-w06 text-ash">
                  Executes automatically at 00:00
                </Text>
              </View>
              <UndoCountdown
                seconds={secondsLeft}
                className="font-mono-medium text-34 tracking-t30 leading-[0.9]"
              />
            </View>
            {note ? <Text className="mb-3 font-mono text-11 text-ash leading-[1.5]">{note}</Text> : null}
            <View className="gap-2.5">
              {mode === 'live' ? (
                <GhostButton onPress={executeNow} disabled={busy} className="py-3.5" textClassName="text-12 tracking-w14">
                  EXECUTE NOW
                </GhostButton>
              ) : null}
              <DangerButton onPress={cancel} disabled={busy}>
                CANCEL TRADE
              </DangerButton>
            </View>
          </>
        ) : (
          <>
            <View className="mb-4 border-t border-hairline py-4">
              <Meta>{PROPOSAL.status === 'executed' ? (PROPOSAL.paper ? 'EXECUTED · PAPER FILL' : 'EXECUTED') : 'NOT EXECUTED'}</Meta>
              <Text className="mt-1.75 font-mono text-10 tracking-w06 text-ash">
                {PROPOSAL.status === 'executed'
                  ? PROPOSAL.paper
                    ? 'The undo window has closed. This was a paper fill: no order reached a venue.'
                    : 'The undo window has closed.'
                  : 'You cancelled inside the undo window.'}
              </Text>
            </View>
            <GhostButton href={routes.home}>BACK TO RULE</GhostButton>
          </>
        )}
      </Footer>
    </Screen>
  );
}
