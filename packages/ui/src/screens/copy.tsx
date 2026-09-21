import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  COPY_MAX_BPS,
  bpsToPercentText,
  formatBps,
  parsePercentToBps,
  previewFollow,
  validateCopyTerms,
} from '@kanon/spec';
import { Body, Footer, NavBar, Screen, StatusBar } from '../components/chrome';
import { BottomSheet } from '../components/bottom-sheet';
import { AmountSheet, AvailabilityNote, Chip, Field, Notice } from '../components/vault-form';
import { Dot, GhostButton, Meta, Num, Panel, PrimaryButton } from '../components/ui';
import { Link } from '../nav';
import { useVaults } from '../lib/domains';
import { routes, shareRoute } from '../lib/routes';
import { formatMoney, parseAmount } from '../lib/vault-map';
import type { CopyFollowView, CopyLeadView, VaultOutcome } from '../lib/vault-types';
import { cx } from '../lib/cx';

const ALLOCATION_PRESETS = [1000, 2500, 5000, 10_000];
/** The leader size and the price move the worked example uses. Stated on screen, never hidden. */
const EXAMPLE_LEADER_UNITS = 1000n;
const EXAMPLE_MOVE_BPS = 500;

/**
 * 14 · COPY TRADING.
 *
 * Follow a strategy someone has pinned, from your own vault. The funds stay
 * yours: the lead can open and close mirrored positions inside your vault and
 * can never withdraw. The fee is one number the lead set, charged only on a
 * profit. Unfollowing is immediate.
 *
 * A lead is judged by adherence to its own rule, not by profit, so that is the
 * figure that leads each card. The terms and a worked example come before the
 * sign-off; nothing about the fee or the size is decided for you.
 */
export function CopyScreen() {
  const { copy, followLead, unfollow } = useVaults();
  const [leadId, setLeadId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'follow' | 'unfollow' | 'fund'>(null);
  const [target, setTarget] = useState<CopyFollowView | null>(null);
  const [notice, setNotice] = useState<VaultOutcome | null>(null);

  const lead: CopyLeadView | undefined = copy.leads.find((l) => l.id === leadId) ?? undefined;
  const demo = copy.availability.state === 'demo';
  const canAct = copy.availability.state === 'ready' || demo;

  return (
    <Screen label="14 · COPY TRADING">
      <StatusBar />
      <NavBar left="←  RULES" leftHref={routes.home} leftClassName="text-ash tracking-w12" right="COPY" />

      <Body>
        <Text className="mt-8 font-sans text-26 font-medium tracking-t20 text-bone leading-[1.14]">
          Follow a rule, not a P&amp;L.
        </Text>
        <Text className="mt-3 font-sans text-13p5 text-ash leading-[1.5]">
          Your funds stay in a vault only you can withdraw from. A lead never touches them.
        </Text>

        <AvailabilityNote state={copy.availability.state} message={'message' in copy.availability ? copy.availability.message : undefined} />

        {copy.following.length > 0 ? (
          <View className="mt-8">
            <Meta className="tracking-w20">YOU FOLLOW · {String(copy.following.length).padStart(2, '0')}</Meta>
            {copy.following.map((f) => (
              <FollowRow
                key={f.address}
                follow={f}
                symbol={copy.collateralSymbol}
                onManage={() => {
                  setTarget(f);
                  setSheet('unfollow');
                }}
                onFund={() => {
                  setTarget(f);
                  setSheet('fund');
                }}
              />
            ))}
          </View>
        ) : null}

        <Meta className="mt-8 tracking-w20">LEAD STRATEGIES</Meta>
        {copy.loading && copy.leads.length === 0 ? (
          <Meta className="mt-4">READING THE CHAIN</Meta>
        ) : copy.leads.length === 0 ? (
          <Text className="mt-3 font-sans text-13 text-ash leading-[1.5]">
            No strategy is listed for copying yet. A strategy is private until its owner lists it.
          </Text>
        ) : (
          <View className="mt-3 gap-3">
            {copy.leads.map((l) => (
              <LeadCard key={l.id} lead={l} selected={l.id === leadId} onSelect={() => setLeadId(l.id === leadId ? null : l.id)} />
            ))}
          </View>
        )}

        <Notice outcome={notice} />
        <View className="h-6" />
      </Body>

      <Footer>
        {lead ? (
          <PrimaryButton disabled={!canAct || lead.blocker !== ''} onPress={() => setSheet('follow')}>
            {lead.blocker !== '' ? 'CANNOT FOLLOW' : 'REVIEW TERMS'}
          </PrimaryButton>
        ) : (
          <GhostButton disabled>SELECT A STRATEGY</GhostButton>
        )}
        {lead && lead.blocker !== '' ? (
          <Text className="mt-2.5 text-center font-mono text-10 text-ash leading-[1.5]">{lead.blocker}</Text>
        ) : null}
      </Footer>

      {lead ? (
        <FollowSheet
          open={sheet === 'follow'}
          onClose={() => setSheet(null)}
          lead={lead}
          symbol={copy.collateralSymbol}
          decimals={copy.collateralDecimals}
          walletBalanceLabel={copy.walletBalance ? formatMoney(copy.walletBalance) : null}
          onSubmit={async (allocationBps, deposit) => {
            const out = await followLead({ leadId: lead.id, allocationBps, deposit });
            setNotice(out);
            return out;
          }}
        />
      ) : null}

      <UnfollowSheet
        open={sheet === 'unfollow'}
        onClose={() => setSheet(null)}
        follow={target}
        symbol={copy.collateralSymbol}
        onSubmit={async (address, withdraw) => {
          const out = await unfollow(address, { withdraw });
          setNotice(out);
          return out;
        }}
      />

      {target ? (
        <FundSheet open={sheet === 'fund'} onClose={() => setSheet(null)} follow={target} />
      ) : null}
    </Screen>
  );
}

/* ------------------------------------------------------------------ */

function LeadCard({ lead, selected, onSelect }: { lead: CopyLeadView; selected: boolean; onSelect: () => void }) {
  return (
    <View className={cx('border bg-panel', selected ? 'border-signal' : 'border-hairline')}>
      <Pressable
        role="button"
        aria-pressed={selected}
        onPress={onSelect}
        aria-label={`${lead.name}. ${selected ? 'Selected' : 'Select'}`}
        className="px-4 pt-4 pb-3.5"
      >
        <View className="flex-row items-center justify-between">
          <Text className="font-mono text-10 tracking-w16 text-signal">STRATEGY CARD</Text>
          <View className="flex-row items-center gap-1.5">
            <Dot className="bg-verified" />
            <Text className="font-mono text-9 tracking-w16 text-verified">VERIFIED ON-CHAIN</Text>
          </View>
        </View>
        <Text className="mt-3 font-mono-medium text-15 tracking-t20 text-bone">{lead.name}</Text>
        <View className="mt-2 flex-row gap-3.5">
          <Num className="text-10 tracking-w10 text-ash">{lead.asset}</Num>
          <Num className="text-10 tracking-w10 text-ash">{lead.timeframe}</Num>
          <Num className="text-10 tracking-w10 text-ash">{lead.specHash}</Num>
        </View>
        {/* Adherence carries the card. It is the claim that can be checked. */}
        <View className="mt-4 flex-row items-end justify-between">
          <View className="gap-2">
            <Meta className="tracking-w16">ADHERENCE</Meta>
            <Num className="font-mono-medium text-30 tracking-t35 text-signal leading-[0.9]">
              {lead.adherenceBps === null ? '—' : formatBps(lead.adherenceBps, { dp: 1 })}
            </Num>
          </View>
          <View className="items-end gap-2">
            <Meta className="tracking-w16">PROFIT SHARE</Meta>
            <Num className="font-mono-medium text-18 tracking-t20">{formatBps(lead.profitShareBps, { dp: 1 })}</Num>
          </View>
        </View>
        <View className="mt-3.5 flex-row gap-5">
          <Num className="text-10 text-ash">TAKEN {lead.taken}</Num>
          <Num className="text-10 text-ash">BLOCKED {String(lead.blocked).padStart(2, '0')}</Num>
        </View>
      </Pressable>

      {selected ? (
        <View className="gap-2 border-t border-hairline px-4 py-3.5">
          {lead.summary.map((line) => (
            <Num key={line} className="text-11p5 text-ash">
              {line}
            </Num>
          ))}
          <Link href={shareRoute(lead.strategyId)} className="mt-1.5 flex-row items-center justify-between border-t border-hairline pt-3">
            <Text className="font-mono text-12 tracking-w04 text-verified">Open the strategy card</Text>
            <Num className="text-11 text-verified">{lead.specHash}{'  ↗'}</Num>
          </Link>
        </View>
      ) : null}
    </View>
  );
}

function FollowRow({
  follow,
  symbol,
  onManage,
  onFund,
}: {
  follow: CopyFollowView;
  symbol: string;
  onManage: () => void;
  onFund: () => void;
}) {
  return (
    <View className="mt-3 border border-hairline bg-panel">
      <View className="flex-row items-center justify-between border-b border-hairline px-4 pt-3.5 pb-3">
        <Text className="flex-1 font-mono-medium text-12 text-bone">{follow.leadName}</Text>
        <View className="flex-row items-center gap-1.5">
          <Dot className={follow.active ? 'bg-signal' : 'border border-ash'} />
          <Text className={cx('font-mono text-9 tracking-w16', follow.active ? 'text-signal' : 'text-ash')}>
            {follow.active ? 'MIRRORING' : 'STOPPED'}
          </Text>
        </View>
      </View>
      <View className="flex-row px-4 py-3.5">
        <View className="flex-1 gap-1.75">
          <Meta>YOU MIRROR</Meta>
          <Num className="font-mono-medium text-15">{formatBps(follow.allocationBps, { dp: 1 })}</Num>
        </View>
        <View className="flex-1 gap-1.75">
          <Meta>FEE ON PROFIT</Meta>
          <Num className="font-mono-medium text-15">{formatBps(follow.feeShareBps, { dp: 1 })}</Num>
        </View>
        <View className="flex-1 items-end gap-1.75">
          <Meta>IN THE VAULT</Meta>
          <Num className="font-mono-medium text-15">{formatMoney(follow.balance)}</Num>
        </View>
      </View>
      <View className="flex-row items-center justify-between border-t border-hairline px-4 py-3">
        <Num className="text-10 text-ash">
          {follow.addressShort} · {follow.mirrored} MIRRORED · {symbol}
        </Num>
      </View>
      <View className="flex-row border-t border-hairline">
        <Pressable role="button" onPress={onFund} className="flex-1 items-center py-3.5">
          <Text className="font-mono text-11 tracking-w14 text-verified">DEPOSIT</Text>
        </Pressable>
        <Pressable role="button" onPress={onManage} className="flex-1 items-center border-l border-hairline py-3.5">
          <Text className="font-mono text-11 tracking-w14 text-bone">{follow.active ? 'UNFOLLOW' : 'WITHDRAW'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */

function FollowSheet({
  open,
  onClose,
  lead,
  symbol,
  decimals,
  walletBalanceLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  lead: CopyLeadView;
  symbol: string;
  decimals: number;
  walletBalanceLabel: string | null;
  onSubmit: (allocationBps: number, deposit: { atoms: string; decimals: number } | null) => Promise<VaultOutcome>;
}) {
  const [allocText, setAllocText] = useState('25');
  const [depositText, setDepositText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VaultOutcome | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setBusy(false);
    }
  }, [open, lead.id]);

  const allocationBps = parsePercentToBps(allocText);
  const terms = { allocationBps: allocationBps ?? 0, feeShareBps: lead.profitShareBps };
  const issues = allocationBps === null ? [] : validateCopyTerms(terms);
  const deposit = depositText.trim() === '' ? null : parseAmount(depositText, decimals);
  const valid = allocationBps !== null && issues.length === 0 && (deposit === null || deposit.ok);

  const preview = useMemo(() => {
    if (allocationBps === null || issues.length > 0) return null;
    const unit = 10n ** BigInt(decimals);
    return previewFollow({ terms, leaderSize: EXAMPLE_LEADER_UNITS * unit, moveBps: EXAMPLE_MOVE_BPS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocationBps, lead.profitShareBps, decimals]);

  const money = (atoms: bigint, signed = false) => formatMoney({ atoms: atoms.toString(), decimals }, { signed });

  return (
    <BottomSheet open={open} onClose={onClose} title="FOLLOW" meta={lead.specHash}>
      <View className="gap-6 pb-2">
        <View className="gap-3">
          <Field
            label="YOU MIRROR"
            value={allocText}
            onChangeText={setAllocText}
            keyboardType="decimal-pad"
            suffix="% OF EACH LEAD TRADE"
            invalid={allocationBps === null || issues.length > 0}
            hint={
              allocationBps === null
                ? 'Enter a percentage with at most two decimals.'
                : issues.length > 0
                  ? issues[0]!.message
                  : `${allocationBps} bps. If the lead opens 1.00, your vault opens ${bpsToPercentText(allocationBps)}% of that, rounded down.`
            }
          />
          <View className="flex-row flex-wrap gap-2">
            {ALLOCATION_PRESETS.map((p) => (
              <Chip
                key={p}
                label={formatBps(p, { dp: 0 })}
                selected={allocationBps === p}
                onPress={() => setAllocText(bpsToPercentText(p))}
              />
            ))}
          </View>
          <Text className="font-mono text-10 text-ash leading-[1.5]">Range 0.01% to {formatBps(COPY_MAX_BPS, { dp: 0 })}.</Text>
        </View>

        {/* The fee is the lead's, shown, and not editable: it is the only fee there is. */}
        <Panel>
          <View className="flex-row items-center justify-between px-4 py-3.5">
            <View className="gap-1.75">
              <Meta>PROFIT SHARE · SET BY THE LEAD</Meta>
              <Text className="font-mono text-10 text-ash leading-[1.5]">Charged on a profitable close only. Never on a loss.</Text>
            </View>
            <Num className="font-mono-medium text-18 tracking-t20">{formatBps(lead.profitShareBps, { dp: 1 })}</Num>
          </View>
        </Panel>

        <Field
          label="DEPOSIT NOW · OPTIONAL"
          value={depositText}
          onChangeText={setDepositText}
          keyboardType="decimal-pad"
          suffix={symbol}
          placeholder="0.00"
          invalid={deposit !== null && !deposit.ok}
          hint={
            deposit !== null && !deposit.ok
              ? deposit.error
              : `Leave empty to fund it later.${walletBalanceLabel ? ` ${walletBalanceLabel} ${symbol} in your wallet.` : ''}`
          }
        />

        {preview ? (
          <View className="gap-2.5 border border-hairline bg-sunken px-4 py-3.5">
            <Meta className="tracking-w16">
              WORKED EXAMPLE · LEAD OPENS {money(preview.leaderSize)} {symbol}
            </Meta>
            <ExampleRow label="YOUR VAULT OPENS" value={money(preview.followerSize)} />
            <ExampleRow label={`CLOSES ${formatBps(EXAMPLE_MOVE_BPS, { dp: 0 })} HIGHER · GAIN`} value={money(preview.exampleProfit, true)} />
            <ExampleRow label="LEAD KEEPS" value={money(preview.fee)} />
            <ExampleRow label="YOU KEEP" value={money(preview.followerNet, true)} />
            <ExampleRow label={`CLOSES ${formatBps(EXAMPLE_MOVE_BPS, { dp: 0 })} LOWER · LOSS`} value={money(preview.exampleLoss, true)} />
            <ExampleRow label="FEE ON A LOSS" value={money(0n)} />
          </View>
        ) : null}

        <Text className="font-mono text-10 text-ash leading-[1.6]">
          Your allocation is fixed in your vault when it is created. Unfollowing is immediate: no hold, no fee, no approval.
        </Text>

        <Notice outcome={result} />
        <PrimaryButton
          disabled={!valid || busy}
          onPress={() => {
            if (allocationBps === null) return;
            setBusy(true);
            const dep = deposit && deposit.ok ? { atoms: deposit.atoms.toString(), decimals } : null;
            void onSubmit(allocationBps, dep)
              .then(setResult)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'WAITING FOR SIGNATURE' : 'SIGN AND FOLLOW'}
        </PrimaryButton>
      </View>
    </BottomSheet>
  );
}

function ExampleRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text className="flex-1 font-mono text-10 tracking-w06 text-ash">{label}</Text>
      <Num className="text-12 text-bone">{value}</Num>
    </View>
  );
}

function UnfollowSheet({
  open,
  onClose,
  follow,
  symbol,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  follow: CopyFollowView | null;
  symbol: string;
  onSubmit: (address: string, withdraw: boolean) => Promise<VaultOutcome>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VaultOutcome | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setBusy(false);
    }
  }, [open, follow?.address]);

  if (!follow) return null;
  const hasBalance = BigInt(follow.balance.atoms) > 0n;

  const run = (withdraw: boolean) => {
    setBusy(true);
    void onSubmit(follow.address, withdraw)
      .then(setResult)
      .finally(() => setBusy(false));
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={follow.active ? 'UNFOLLOW' : 'WITHDRAW'} meta={follow.addressShort}>
      <View className="gap-5 pb-2">
        <Text className="font-sans text-13p5 text-bone leading-[1.5]">
          {follow.active
            ? 'Mirroring stops the moment this is signed. No hold, no fee, no approval from the lead.'
            : 'Mirroring is already stopped. The balance is yours to take out.'}
        </Text>
        <Panel>
          <View className="flex-row items-center justify-between px-4 py-3.5">
            <Meta>IN THE VAULT</Meta>
            <Num className="font-mono-medium text-18">
              {formatMoney(follow.balance)} <Text className="text-10 text-ash">{symbol}</Text>
            </Num>
          </View>
        </Panel>
        <Notice outcome={result} />
        {follow.active ? (
          <>
            <PrimaryButton disabled={busy} onPress={() => run(false)}>
              {busy ? 'WAITING FOR SIGNATURE' : 'UNFOLLOW'}
            </PrimaryButton>
            {hasBalance ? (
              <GhostButton disabled={busy} onPress={() => run(true)}>
                UNFOLLOW AND WITHDRAW
              </GhostButton>
            ) : null}
          </>
        ) : hasBalance ? (
          <PrimaryButton disabled={busy} onPress={() => run(true)}>
            {busy ? 'WAITING FOR SIGNATURE' : 'WITHDRAW'}
          </PrimaryButton>
        ) : null}
      </View>
    </BottomSheet>
  );
}

function FundSheet({ open, onClose, follow }: { open: boolean; onClose: () => void; follow: CopyFollowView }) {
  const { fundVault, copy } = useVaults();
  return (
    <AmountSheet
      open={open}
      onClose={onClose}
      title="DEPOSIT"
      action="DEPOSIT"
      decimals={copy.collateralDecimals}
      symbol={copy.collateralSymbol}
      available={copy.walletBalance}
      availableLabel="IN YOUR WALLET"
      onSubmit={(amount) => fundVault(follow.address, amount)}
      note={
        <Text className="font-mono text-10 text-ash leading-[1.5]">
          Into {follow.addressShort}. Only you can withdraw it.
        </Text>
      }
    />
  );
}
