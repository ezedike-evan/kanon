import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  SUGGESTED_DAILY_DRAWDOWN_BPS,
  bpsToPercentText,
  classifyVaultChange,
  formatBps,
  parsePercentToBps,
  validateVaultLimits,
  type VaultChange,
} from '@kanon/spec';
import { Body, Footer, NavBar, Screen, StatusBar } from '../components/chrome';
import { BottomSheet } from '../components/bottom-sheet';
import { CoolingOffCountdown } from '../components/countdown';
import { AmountSheet, AvailabilityNote, Chip, Field, Notice } from '../components/vault-form';
import { Dot, GhostButton, Meta, Num, Panel, PrimaryButton } from '../components/ui';
import { useKanonData } from '../lib/data';
import { useVaults } from '../lib/domains';
import { routes } from '../lib/routes';
import { formatMoney } from '../lib/vault-map';
import type { VaultOutcome, VaultParamsInput, VaultRefusalRow, VaultView } from '../lib/vault-types';
import { cx } from '../lib/cx';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DRAWDOWN_PRESETS = [100, 200, 300, 500];

/** The parameters, as the form holds them: the drawdown as text so a half-typed "1." is not lost. */
interface Draft {
  assets: string[];
  drawdownText: string;
  executor: string;
}

const draftOf = (p: VaultParamsInput): Draft => ({
  assets: p.assets,
  drawdownText: bpsToPercentText(p.maxDailyDrawdownBps),
  executor: p.executor,
});

function readDraft(d: Draft): { input: VaultParamsInput | null; problems: string[] } {
  const bps = parsePercentToBps(d.drawdownText);
  const problems: string[] = [];
  if (bps === null) problems.push('Enter the daily drawdown as a percentage with at most two decimals, for example 2.');
  if (!ADDRESS.test(d.executor)) problems.push('The executor must be a full 0x address.');
  const input = { assets: d.assets, maxDailyDrawdownBps: bps ?? 0, executor: d.executor };
  if (bps !== null) problems.push(...validateVaultLimits(input).map((i) => i.message));
  return { input: problems.length === 0 ? input : null, problems };
}

/**
 * 13 · GUARDED AGENT VAULT.
 *
 * Funds an agent can trade with and cannot spend outside its rule. The
 * whitelist and the daily drawdown cap are fixed in the contract when the vault
 * is made: there is no setter and no admin. So every parameter is on this
 * screen, editable, before anything is signed, and a vault that refuses a trade
 * shows the predicate that refused and the number that failed it.
 *
 * P&L is not the lead here. The balance and the limits are; realized P&L sits
 * inside the guard panel, below the fold.
 */
export function VaultScreen() {
  const { rule } = useKanonData();
  const { vaults, createVault, changeVault, cancelVaultChange, fundVault, withdrawFromVault } = useVaults();
  const [selected, setSelected] = useState(0);
  const [sheet, setSheet] = useState<null | 'deposit' | 'withdraw' | 'limits'>(null);
  const [notice, setNotice] = useState<VaultOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const vault: VaultView | undefined = vaults.vaults[Math.min(selected, vaults.vaults.length - 1)];
  const ready = vaults.availability.state === 'ready' && !vaults.blocker;
  const demo = vaults.availability.state === 'demo';
  const canAct = ready || demo;

  return (
    <Screen label="13 · GUARDED AGENT VAULT">
      <StatusBar />
      <NavBar left="←  RULES" leftHref={routes.home} leftClassName="text-ash tracking-w12" right="AGENT VAULT" />

      <Body>
        <Text className="mt-8 font-sans text-26 font-medium tracking-t20 text-bone leading-[1.14]">
          {vault ? 'Funds that stay inside your rule.' : 'Give an agent funds, and a rule it cannot leave.'}
        </Text>

        <AvailabilityNote state={vaults.availability.state} message={'message' in vaults.availability ? vaults.availability.message : undefined} />
        {vaults.blocker ? (
          <View className="mt-5 gap-2 border border-hairline bg-panel px-3.5 py-3">
            <Text className="font-sans text-13 text-bone leading-[1.5]">{vaults.blocker}</Text>
          </View>
        ) : null}

        {vaults.loading && !vault ? (
          <Meta className="mt-8 tracking-w20">READING THE CHAIN</Meta>
        ) : vault ? (
          <VaultBody
            vault={vault}
            all={vaults.vaults}
            selected={Math.min(selected, vaults.vaults.length - 1)}
            onSelect={setSelected}
            symbol={vaults.collateralSymbol}
            decimals={vaults.collateralDecimals}
            onCancelChange={async () => {
              setBusy(true);
              setNotice(await cancelVaultChange(vault.address));
              setBusy(false);
            }}
            busy={busy}
            holdSeconds={vaults.holdSeconds}
          />
        ) : (
          <CreateForm
            key={vaults.defaults.executor}
            defaults={{
              assets: vaults.defaults.assets,
              maxDailyDrawdownBps: vaults.defaults.maxDailyDrawdownBps,
              executor: vaults.defaults.executor,
            }}
            universe={vaults.universe}
            strategy={rule.name}
            asset={rule.asset}
            symbol={vaults.collateralSymbol}
            disabled={!canAct}
            onSubmit={async (input) => {
              const out = await createVault(input);
              setNotice(out);
              return out;
            }}
          />
        )}

        <Notice outcome={notice} />
        <View className="h-6" />
      </Body>

      {vault ? (
        <Footer className="gap-2.5">
          <View className="flex-row gap-2.5">
            <GhostButton className="flex-1" disabled={!canAct} onPress={() => setSheet('withdraw')}>
              WITHDRAW
            </GhostButton>
            <PrimaryButton className="flex-1" disabled={!canAct} onPress={() => setSheet('deposit')}>
              DEPOSIT
            </PrimaryButton>
          </View>
          <Pressable role="button" onPress={() => setSheet('limits')} className="items-center py-2">
            <Text className="font-mono text-11 tracking-w14 text-verified">CHANGE LIMITS</Text>
          </Pressable>
        </Footer>
      ) : null}

      {vault ? (
        <>
          <AmountSheet
            open={sheet === 'deposit'}
            onClose={() => setSheet(null)}
            title="DEPOSIT"
            action="DEPOSIT"
            decimals={vaults.collateralDecimals}
            symbol={vaults.collateralSymbol}
            available={vaults.walletBalance}
            availableLabel="IN YOUR WALLET"
            onSubmit={(amount) => fundVault(vault.address, amount)}
            note={
              <Text className="font-mono text-10 text-ash leading-[1.5]">
                Anyone can add to a vault. Only you can take funds out.
              </Text>
            }
          />
          <AmountSheet
            open={sheet === 'withdraw'}
            onClose={() => setSheet(null)}
            title="WITHDRAW"
            action="WITHDRAW"
            decimals={vaults.collateralDecimals}
            symbol={vaults.collateralSymbol}
            available={vault.balance}
            availableLabel="IN THE VAULT"
            onSubmit={(amount) => withdrawFromVault(vault.address, amount)}
            note={
              <Text className="font-mono text-10 text-ash leading-[1.5]">
                Withdrawing is always yours to do. The executor cannot.
              </Text>
            }
          />
          <LimitsSheet
            open={sheet === 'limits'}
            onClose={() => setSheet(null)}
            vault={vault}
            universe={vaults.universe}
            holdSeconds={vaults.holdSeconds}
            onSubmit={(input) => changeVault(vault.address, input)}
          />
        </>
      ) : null}
    </Screen>
  );
}

/* ------------------------------------------------------------------ */

function VaultBody({
  vault,
  all,
  selected,
  onSelect,
  symbol,
  decimals,
  onCancelChange,
  busy,
  holdSeconds,
}: {
  vault: VaultView;
  all: VaultView[];
  selected: number;
  onSelect: (i: number) => void;
  symbol: string;
  decimals: number;
  onCancelChange: () => void;
  busy: boolean;
  holdSeconds: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const guard = vault.guard;

  return (
    <View>
      {all.length > 1 ? (
        <View className="mt-5 flex-row flex-wrap gap-2">
          {all.map((v, i) => (
            <Chip key={v.address} label={v.addressShort} selected={i === selected} onPress={() => onSelect(i)} />
          ))}
        </View>
      ) : null}

      <Panel className="mt-6">
        <View className="flex-row items-center justify-between border-b border-hairline px-4 pt-4 pb-3.5">
          <Num className="text-10 tracking-w16 text-signal">{vault.addressShort}</Num>
          <View className="flex-row items-center gap-1.5">
            <Dot className="bg-signal" />
            <Text className="font-mono text-9 tracking-w16 text-signal">ENFORCED ON-CHAIN</Text>
          </View>
        </View>
        <View className="gap-2 px-4 py-4">
          <Meta>IN THE VAULT</Meta>
          <Num className="font-mono-medium text-34 tracking-t35 leading-[0.9]">{formatMoney(vault.balance)}</Num>
          <Num className="text-11 text-ash">{symbol}</Num>
        </View>
        <View className="gap-2 border-t border-hairline px-4 py-3.5">
          <Meta>BOUND TO</Meta>
          <Text className="font-mono text-12 text-bone">{vault.strategyLabel}</Text>
        </View>
      </Panel>

      <Meta className="mt-7 tracking-w20">WHITELIST · FIXED AT CREATION</Meta>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {vault.assets.map((a) => (
          <View key={a} className="flex-row items-center gap-1.5 border border-hairline bg-panel px-2.5 py-2">
            <Dot className="bg-signal" />
            <Text className="font-mono text-11 tracking-w06 text-bone">{a}</Text>
          </View>
        ))}
      </View>
      <Text className="mt-2.5 font-mono text-10 text-ash leading-[1.5]">
        Anything else is refused by the contract before it reaches a market.
      </Text>

      {/* The cap and what is left of it today. */}
      <Panel className="mt-7">
        <View className="border-b border-hairline px-4 pt-3.5 pb-3">
          <Meta>DAILY DRAWDOWN CAP</Meta>
        </View>
        <View className="flex-row items-end justify-between px-4 pt-3.5">
          <Num className="font-mono-medium text-26 tracking-t30">{formatBps(vault.maxDailyDrawdownBps)}</Num>
          <Num className="text-11 text-ash">
            OF {formatMoney(guard.referenceBalance)} OPENING
          </Num>
        </View>
        <View className="mx-4 mt-3.5 h-1.5 bg-raised" aria-hidden>
          <View
            className="h-1.5 bg-signal"
            style={{ width: `${meterPercent(guard.usedBps, vault.maxDailyDrawdownBps)}%` }}
          />
        </View>
        <View className="flex-row justify-between px-4 pt-2.5 pb-3.5">
          <Num className="text-10 text-ash">BUDGET {formatMoney(guard.lossBudget)}</Num>
          <Num className="text-10 text-bone">LEFT {formatMoney(guard.remaining)}</Num>
        </View>
        <View className="flex-row items-center justify-between border-t border-hairline px-4 py-3">
          <Meta>EXECUTOR</Meta>
          <Num className="text-11 text-ash">{vault.executorShort} · CANNOT WITHDRAW</Num>
        </View>
      </Panel>

      {vault.pending ? (
        <View className="mt-7 border border-signal bg-diff-wash px-4 pt-4 pb-4">
          <Meta className="tracking-w20 text-signal">LOOSER LIMITS APPLY IN</Meta>
          <CoolingOffCountdown
            requestedAt={vault.pending.requestedAt}
            holdSeconds={holdSeconds}
            nowAt={now}
          />
          <Text className="mt-3 font-mono text-10 text-ash leading-[1.5]">
            {vault.pending.assets.join(' · ')} · cap {formatBps(vault.pending.maxDailyDrawdownBps)}. Until then this vault keeps
            its current limits.
          </Text>
          <Pressable role="button" disabled={busy} onPress={onCancelChange} className="mt-3 py-1.5">
            <Text className="font-mono text-11 tracking-w14 text-verified">WITHDRAW CHANGE</Text>
          </Pressable>
        </View>
      ) : null}

      <Meta className="mt-8 tracking-w20">
        REFUSED BY THE VAULT · {String(vault.refusals.length).padStart(2, '0')}
      </Meta>
      {vault.refusals.length === 0 ? (
        <Text className="mt-3 font-sans text-13 text-ash leading-[1.5]">
          Nothing has been refused yet. When the gate stops a trade, the predicate and the number that failed it appear here.
        </Text>
      ) : (
        <View className="mt-3">
          {vault.refusals.map((row) => (
            <RefusalItem key={row.id} row={row} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} />
          ))}
        </View>
      )}

      {/* P&L lives here, inside the guard, and nowhere above it. */}
      <View className="mt-7 flex-row items-center justify-between border-t border-hairline pt-3.5">
        <Text className="font-mono text-11 tracking-w06 text-ash">REALIZED TODAY · UTC</Text>
        <Num className="text-11 text-bone">{formatMoney(guard.realizedToday, { signed: true })}</Num>
      </View>
      <Num className="mt-1 text-10 text-ash">{decimals} DECIMAL TOKEN · INTEGER ARITHMETIC</Num>
    </View>
  );
}

/** How much of the cap the day has used, 0..100, from integer bps. */
export function meterPercent(usedBps: number, capBps: number): number {
  if (capBps <= 0) return 0;
  return Math.min(100, Math.floor((usedBps * 100) / capBps));
}

function RefusalItem({ row, open, onToggle }: { row: VaultRefusalRow; open: boolean; onToggle: () => void }) {
  return (
    <View className="border-t border-hairline">
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={onToggle}
        className="flex-row gap-3 py-3.5"
        aria-label={`Refusal on ${row.asset}: ${row.predicate}. Show evidence`}
      >
        <Dot className="mt-1.25 bg-refused" />
        <View className="flex-1 gap-2">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="font-mono-medium text-12 text-bone">{row.asset}</Text>
            <Num className="text-10 text-ash">{row.at}</Num>
          </View>
          {/* The predicate, and the number that failed it. Always both. */}
          <Text className="font-mono text-11p5 text-ash leading-[1.5]">{row.predicate}</Text>
          <View className="flex-row flex-wrap items-baseline gap-x-4 gap-y-1">
            <Num className="text-12p5 text-bone">{row.failing}</Num>
            <Num className="text-10p5 text-ash">NEEDED {row.required}</Num>
          </View>
          <Text className="font-mono text-10 tracking-w10 text-verified">
            {open ? 'HIDE EVIDENCE' : 'EVIDENCE'} · {row.txAbbrev} {open ? '↑' : '↗'}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <View className="mb-3.5 gap-2 border border-hairline bg-sunken px-3.5 py-3">
          {row.evidence.map(([k, v]) => (
            <View key={k} className="gap-0.5">
              <Meta>{k}</Meta>
              <Num className="text-10p5 text-bone" >{v}</Num>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */

/** Every parameter, editable, with what will be signed spelled out under it. */
function LimitsForm({
  universe,
  draft,
  onChange,
  defaultBps,
}: {
  universe: string[];
  draft: Draft;
  onChange: (d: Draft) => void;
  defaultBps: number | null;
}) {
  const bps = parsePercentToBps(draft.drawdownText);
  const untouchedDefault = defaultBps !== null && bps === defaultBps;
  return (
    <View className="gap-6">
      <View className="gap-3">
        <Meta className="tracking-w16">ASSET WHITELIST</Meta>
        <View className="flex-row flex-wrap gap-2">
          {universe.map((a) => {
            const on = draft.assets.includes(a);
            return (
              <Chip
                key={a}
                label={a}
                selected={on}
                onPress={() =>
                  onChange({ ...draft, assets: on ? draft.assets.filter((x) => x !== a) : [...draft.assets, a] })
                }
              />
            );
          })}
        </View>
      </View>

      <View className="gap-3">
        <Field
          label={untouchedDefault ? 'DAILY DRAWDOWN CAP · STARTING VALUE' : 'DAILY DRAWDOWN CAP'}
          value={draft.drawdownText}
          onChangeText={(t) => onChange({ ...draft, drawdownText: t })}
          keyboardType="decimal-pad"
          suffix="%"
          invalid={bps === null}
          hint={
            bps === null
              ? undefined
              : `${bps} bps of the day's opening balance. Losses past this refuse every further trade until the next UTC day.`
          }
        />
        <View className="flex-row flex-wrap gap-2">
          {DRAWDOWN_PRESETS.map((p) => (
            <Chip
              key={p}
              label={formatBps(p, { dp: 1 })}
              selected={bps === p}
              onPress={() => onChange({ ...draft, drawdownText: bpsToPercentText(p) })}
            />
          ))}
        </View>
      </View>

      <Field
        label="EXECUTOR ADDRESS"
        value={draft.executor}
        onChangeText={(t) => onChange({ ...draft, executor: t.trim() })}
        placeholder="0x…"
        hint="The key that proposes trades, for example an agent. It can never withdraw. Yours by default."
      />
    </View>
  );
}

function CreateForm({
  defaults,
  universe,
  strategy,
  asset,
  symbol,
  disabled,
  onSubmit,
}: {
  defaults: VaultParamsInput;
  universe: string[];
  strategy: string;
  asset: string;
  symbol: string;
  disabled: boolean;
  onSubmit: (input: VaultParamsInput) => Promise<VaultOutcome>;
}) {
  const [draft, setDraft] = useState<Draft>(draftOf(defaults));
  const [busy, setBusy] = useState(false);
  const { input, problems } = useMemo(() => readDraft(draft), [draft]);

  return (
    <View className="mt-7">
      <LimitsForm universe={universe} draft={draft} onChange={setDraft} defaultBps={SUGGESTED_DAILY_DRAWDOWN_BPS} />

      {/* What is about to be signed, in full. Nothing here is decided for you. */}
      <Panel className="mt-7">
        <View className="border-b border-hairline px-4 pt-3.5 pb-3">
          <Meta>WHAT YOU WILL SIGN</Meta>
        </View>
        <SummaryRow label="BOUND TO" value={strategy} />
        <SummaryRow label="SERIES · FROM YOUR PINNED RULE" value={asset} />
        <SummaryRow label="WHITELIST" value={draft.assets.length ? draft.assets.join(' · ') : 'NONE'} />
        <SummaryRow
          label="DAILY DRAWDOWN"
          value={input ? formatBps(input.maxDailyDrawdownBps) : '—'}
        />
        <SummaryRow label="EXECUTOR" value={draft.executor ? shorten(draft.executor) : '—'} />
        <SummaryRow label="COLLATERAL" value={symbol} last />
      </Panel>
      <Text className="mt-3 font-mono text-10 text-ash leading-[1.6]">
        The whitelist and the cap are fixed in the contract once it is created. There is no setter and no admin key. A different
        limit is a different vault.
      </Text>
      {problems.length > 0 && draft.assets.length + draft.executor.length > 0 ? (
        <View className="mt-3 gap-1">
          {problems.map((p) => (
            <Text key={p} className="font-mono text-10p5 text-signal leading-[1.5]">
              {p}
            </Text>
          ))}
        </View>
      ) : null}

      <View className="mt-6">
        <PrimaryButton
          disabled={disabled || !input || busy}
          onPress={() => {
            if (!input) return;
            setBusy(true);
            void onSubmit(input).finally(() => setBusy(false));
          }}
        >
          {busy ? 'WAITING FOR SIGNATURE' : 'CREATE VAULT'}
        </PrimaryButton>
      </View>
    </View>
  );
}

const shorten = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View className={cx('flex-row items-start justify-between gap-4 px-4 py-3', !last && 'border-b border-hairline')}>
      <Meta>{label}</Meta>
      <Num className="flex-1 text-right text-11p5 text-bone">{value}</Num>
    </View>
  );
}

/* ------------------------------------------------------------------ */

function LimitsSheet({
  open,
  onClose,
  vault,
  universe,
  holdSeconds,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  vault: VaultView;
  universe: string[];
  holdSeconds: number;
  onSubmit: (input: VaultParamsInput) => Promise<VaultOutcome>;
}) {
  const start: VaultParamsInput = {
    assets: vault.assets,
    maxDailyDrawdownBps: vault.maxDailyDrawdownBps,
    executor: vault.executor,
  };
  const [draft, setDraft] = useState<Draft>(draftOf(start));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VaultOutcome | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(draftOf(start));
      setResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vault.address]);

  const { input, problems } = readDraft(draft);
  const change: VaultChange | null = input
    ? classifyVaultChange(
        { assets: vault.assets, maxDailyDrawdownBps: vault.maxDailyDrawdownBps },
        { assets: input.assets, maxDailyDrawdownBps: input.maxDailyDrawdownBps },
        holdSeconds,
      )
    : null;

  return (
    <BottomSheet open={open} onClose={onClose} title="CHANGE LIMITS" meta={vault.addressShort}>
      <View className="gap-6 pb-2">
        <Text className="font-sans text-13 text-ash leading-[1.5]">
          Limits are fixed in the contract, so a change is a new vault with the new limits. This one keeps enforcing its own until
          you have moved your funds.
        </Text>
        <LimitsForm universe={universe} draft={draft} onChange={setDraft} defaultBps={null} />

        {change ? (
          <View
            className={cx(
              'gap-2 border px-3.5 py-3',
              change.kind === 'loosen' ? 'border-signal bg-diff-wash' : 'border-hairline bg-panel',
            )}
          >
            <Text
              className={cx('font-mono text-10 tracking-w16', change.kind === 'loosen' ? 'text-signal' : 'text-bone')}
            >
              {change.kind === 'none'
                ? 'NO CHANGE'
                : change.kind === 'tighten'
                  ? 'TIGHTER · APPLIES AT ONCE'
                  : `LOOSER · ${Math.round(holdSeconds / 3600)} HOUR HOLD`}
            </Text>
            {change.kind === 'loosen' ? (
              <Text className="font-mono text-10p5 text-ash leading-[1.5]">
                A looser vault waits out a cooling-off first, with a countdown you cannot skip or pause. The hold is enforced by
                Kanon here, not by the contract.
              </Text>
            ) : null}
            {change.items.map((it) => (
              <Num key={it.field + it.direction} className="text-11 text-ash">
                {it.field === 'assets'
                  ? it.added.length > 0
                    ? `+ ${it.added.join(', ')}`
                    : `− ${it.removed.join(', ')}`
                  : `${formatBps(it.before)} → ${formatBps(it.after)}`}
              </Num>
            ))}
          </View>
        ) : null}

        {problems.map((p) => (
          <Text key={p} className="font-mono text-10p5 text-signal leading-[1.5]">
            {p}
          </Text>
        ))}
        <Notice outcome={result} />
        <PrimaryButton
          disabled={!input || !change || change.kind === 'none' || busy}
          onPress={() => {
            if (!input) return;
            setBusy(true);
            void onSubmit(input)
              .then(setResult)
              .finally(() => setBusy(false));
          }}
        >
          {busy
            ? 'WORKING'
            : change?.kind === 'loosen'
              ? 'START THE HOLD'
              : 'CREATE THE TIGHTER VAULT'}
        </PrimaryButton>
      </View>
    </BottomSheet>
  );
}
