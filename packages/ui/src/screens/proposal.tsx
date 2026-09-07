import { Text, View } from 'react-native';
import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, BrandBar, Footer, Screen, StatusBar } from '../components/chrome';
import { UndoCountdown } from '../components/countdown';
import { DangerButton, Dot, Meta, Num, Panel } from '../components/ui';
import { PROPOSAL, RULE } from '../lib/demo';
import { routes } from '../lib/routes';
import { cx } from '../lib/cx';

/**
 * 05 · TRADE PROPOSAL · UNDO WINDOW.
 *
 * The setup satisfied the spec, so it executes. Each predicate is shown beside
 * the arithmetic that satisfied it — the same comparison the contract made, in
 * the same direction, with the same numbers.
 */
export function ProposalScreen() {
  return (
    <Screen rail="bg-long" label="05 · TRADE PROPOSAL · UNDO WINDOW">
      <StatusBar />
      <BrandBar status={`${RULE.ordinal} SATISFIED`} dot="bg-long" />

      <Body>
        <View className="mt-7.5 flex-row items-center gap-2.25">
          <Dot size="size-2" className="bg-long" />
          <Text className="font-mono-bold text-11 tracking-w20 text-long">
            SETUP VALID · EXECUTING
          </Text>
        </View>
        <Text className="mt-3.5 font-sans text-30 font-medium tracking-t25 text-bone leading-[1.08]">
          Long {RULE.asset.replace(/ /g, '')}
        </Text>

        <Panel className="mt-6">
          {(
            [
              ['ENTRY', PROPOSAL.entry],
              ['STOP', PROPOSAL.stop],
              ['TARGET', PROPOSAL.target],
            ] as const
          ).map(([label, value]) => (
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
                {formatDecimal(PROPOSAL.size)} BTC
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
        <View className="mb-4 flex-row items-end justify-between border-t border-hairline py-4">
          <View className="gap-1.75">
            <Meta>UNDO WINDOW</Meta>
            <Text className="font-mono text-10 tracking-w06 text-ash">
              Executes automatically at 00:00
            </Text>
          </View>
          <UndoCountdown
            seconds={PROPOSAL.undoSeconds}
            className="font-mono-medium text-34 tracking-t30 leading-[0.9]"
          />
        </View>
        <DangerButton href={routes.blocked}>CANCEL TRADE</DangerButton>
      </Footer>
    </Screen>
  );
}
