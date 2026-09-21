import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import {
  formatBps,
  formatDecimal,
  truncateDecimal,
  type AnalyticsReport,
  type Decimal,
  type NansenState,
  type RiskSnapshot,
} from '@kanon/spec';
import { Body, NavBar, Screen, StatusBar, TabBar } from '../components/chrome';
import { Dot, Meta, Num, Panel } from '../components/ui';
import { Link } from '../nav';
import { useKanonData } from '../lib/data';
import { loosenRoute, routes, tradeRoute } from '../lib/routes';
import { cx } from '../lib/cx';

/**
 * 12 · ANALYTICS.
 *
 * Reached from the rule and the strategy card, not a tab. It leads with what the
 * product is for: how often the rule held and what the refusals kept you out of.
 * Then risk, read off the margin account the way the contract reads it. Then
 * Nansen's smart-money flow, as context with its source on it. Profit is the
 * last line on the page, labelled as modelled, and never above the fold.
 *
 * Every claim opens onto the numbers behind it: the strip and the loss figure go
 * to the refusal log, each predicate to its latest refusal's evidence chain, and
 * the risk, drawdown and flow blocks expand in place to their working.
 */

const NANSEN_DOCS = 'https://docs.nansen.ai/api/smart-money/netflows';

// ---------------------------------------------------------------------------
// Small pure helpers. Money is a `Decimal` and stays one until it is a string.
// ---------------------------------------------------------------------------

const two = (n: number) => String(n).padStart(2, '0');
const money = (d: Decimal, signed = false) => formatDecimal(d, { signed });
const pct = (bps: number, dp = 1) => formatBps(bps, { dp });
const factor = (d: Decimal) => `${formatDecimal(truncateDecimal(d, 2))}×`;

/** `09-02 14:32`, UTC, the same stamp the refusal log uses. */
const stamp = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');

function clock(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

const ONE = 10n ** 18n;

/** Where a health factor sits on a 0 to 3.0× scale, in percent to one place. */
function scalePct(atoms: bigint): number {
  const cap = 3n * ONE;
  const clamped = atoms < 0n ? 0n : atoms > cap ? cap : atoms;
  return Number((clamped * 1000n) / cap) / 10;
}

/** A curve as bar heights, 8 to 100 percent of its own range. */
function barHeights(points: readonly Decimal[]): number[] {
  if (points.length === 0) return [];
  const decimals = points.reduce((m, p) => Math.max(m, p.decimals), 0);
  const atoms = points.map((p) => BigInt(p.atoms) * 10n ** BigInt(decimals - p.decimals));
  const lo = atoms.reduce((m, a) => (a < m ? a : m));
  const hi = atoms.reduce((m, a) => (a > m ? a : m));
  const span = hi - lo;
  return atoms.map((a) => (span === 0n ? 50 : 8 + Number(((a - lo) * 92n) / span)));
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="mt-7 border-t border-hairline pt-5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Meta className="tracking-w20">{title}</Meta>
        {right}
      </View>
      {children}
    </View>
  );
}

/** One tap to the working behind a figure. Expands in place: no sheet, no navigation. */
function Working({ label = 'SHOW WORKING', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="mt-4">
      <Pressable
        onPress={() => setOpen(!open)}
        role="button"
        aria-expanded={open}
        className="flex-row items-center gap-2 py-1.5"
      >
        <Text className="font-mono text-10 tracking-w14 text-verified">{label}</Text>
        <Text className="font-mono text-10 text-verified" aria-hidden>
          {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {open ? <View className="mt-2 gap-2 border-l border-hairline pl-3.5">{children}</View> : null}
    </View>
  );
}

function Line({ name, value, className }: { name: string; value: string; className?: string }) {
  return (
    <View className="flex-row justify-between gap-3">
      <Text className="font-mono text-11p5 text-ash">{name}</Text>
      <Num className={cx('shrink text-right text-11p5', className)}>{value}</Num>
    </View>
  );
}

function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Pressable
      role="link"
      {...(className ? { className } : {})}
      onPress={() => {
        Linking.openURL(href).catch(() => {});
      }}
      {...(Platform.OS === 'web'
        ? ({ href, target: '_blank', rel: 'noopener noreferrer' } as object)
        : null)}
    >
      {children}
    </Pressable>
  );
}

function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Text className={cx('font-mono text-10 text-ash leading-[1.5]', className)}>{children}</Text>
  );
}

// ---------------------------------------------------------------------------
// 1 · Adherence and refusals
// ---------------------------------------------------------------------------

function Adherence({ report }: { report: AnalyticsReport }) {
  const { adherence: a, avoided: v } = report;
  const started = a.attempts > 0;

  return (
    <>
      <Meta className="mt-6 tracking-w20">ADHERENCE · {report.asset.replace('/', ' / ')}</Meta>

      {/* The same strip as the rule card, so the two read as one instrument. */}
      <Link
        href={routes.blocked}
        aria-label="Every refusal, with the number that failed it"
        className="mt-3 flex-row border-y border-hairline"
      >
        <View className="flex-1 gap-2 pt-4 pb-3.5">
          <Meta>TAKEN</Meta>
          <Num className="font-mono-medium text-20 tracking-t20">{a.satisfied}</Num>
        </View>
        <View className="flex-1 gap-2 pt-4 pb-3.5">
          <Meta>REFUSED</Meta>
          <View className="flex-row items-center gap-1.75">
            <Dot className="bg-refused" />
            <Num className="font-mono-medium text-20 tracking-t20">{two(a.refused)}</Num>
          </View>
        </View>
        <View className="flex-[1.3] items-end gap-2 pt-4 pb-3.5">
          <Meta>ADHERENCE</Meta>
          <Num className="font-mono-medium text-34 tracking-t35 leading-[0.9]">
            {a.adherenceBps === null ? '—' : pct(a.adherenceBps)}
          </Num>
        </View>
      </Link>

      {started ? (
        <View className="mt-3 h-1 w-full flex-row gap-0.5" aria-hidden>
          <View style={{ flex: Math.max(1, a.satisfied) }} className="bg-ash" />
          {a.refused > 0 ? <View style={{ flex: a.refused }} className="bg-refused" /> : null}
        </View>
      ) : null}
      <Note className="mt-2.5">
        {started
          ? `${a.attempts} setups put to the rule. ${a.satisfied} satisfied it and ran. ${a.refused} did not and were refused.` +
            (a.breaches > 0 ? ` ${a.breaches} ran without a satisfied predicate.` : '')
          : 'No setup has been put to the rule yet. Adherence starts with the first.'}
      </Note>
      {a.undone > 0 || a.proposed > 0 ? (
        <Note className="mt-1">
          {a.undone > 0 ? `${a.undone} cancelled in the undo window` : ''}
          {a.undone > 0 && a.proposed > 0 ? ', ' : ''}
          {a.proposed > 0 ? `${a.proposed} still inside it` : ''}. Neither is counted above.
        </Note>
      ) : null}

      {/* What the refusals kept you out of. The evidence is the refusal log. */}
      {a.refused > 0 ? (
        <Link
          href={routes.blocked}
          aria-label="Refusals modelled to their own stop"
          className="mt-7 gap-2"
        >
          <Meta>LOSS AVOIDED · MODELLED</Meta>
          <Num className="font-mono-medium text-31 tracking-t30 leading-[0.9]">
            {v.judged > 0 ? money(v.lossAvoided) : '—'}
          </Num>
          <Text className="font-mono text-11 text-ash leading-[1.5]">
            {v.judged > 0
              ? `${v.wouldHaveLostCount} of ${v.judged} judged would have lost.`
              : 'No later price data yet, so no verdict is claimed.'}
            {v.wouldHaveWonCount > 0
              ? ` ${v.wouldHaveWonCount} would have made ${money(v.gainForegone)}.`
              : ''}
          </Text>
          <Note>
            Each refused setup played forward to its own stop, or marked at the latest close.
            {v.pending > 0 ? ` ${v.pending} awaiting price data.` : ''}
            {report.truncated ? ' The oldest verdicts may be missing: the price read hit its ceiling.' : ''}
          </Note>
        </Link>
      ) : null}
    </>
  );
}

function ByPredicate({ report }: { report: AnalyticsReport }) {
  if (report.byPredicate.length === 0) return null;
  return (
    <Section title={`REFUSED BY PREDICATE · ${report.byPredicate.length}`}>
      <View className="mt-3">
        {report.byPredicate.map((row) => (
          <Link
            key={row.predicateId}
            href={tradeRoute(row.latestTradeId)}
            aria-label={`${row.label}: ${row.count} refusals. Open the latest.`}
            className="gap-2.5 border-t border-hairline py-3.5"
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="flex-1 font-mono-medium text-12 text-bone">{row.label}</Text>
              <View className="flex-row items-baseline gap-3">
                <Num className="text-10 text-ash">{pct(row.shareBps)}</Num>
                <Num className="font-mono-medium text-15 text-bone">{two(row.count)}</Num>
                <Text className="font-mono text-11 text-ash" aria-hidden>
                  ›
                </Text>
              </View>
            </View>
            <View className="h-0.75 w-full bg-raised" aria-hidden>
              <View style={{ width: `${row.shareBps / 100}%` }} className="h-full bg-refused" />
            </View>
            <Num className="text-11 text-ash">
              {row.lostCount} would have lost
              {row.lostCount > 0 ? ` · ${money(row.lossAvoided)} avoided` : ''} · latest {stamp(row.latestAt)}
            </Num>
          </Link>
        ))}
      </View>
      <Note className="mt-1">Tap a predicate for its latest refusal and the attested numbers behind it.</Note>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 2 · Risk
// ---------------------------------------------------------------------------

const BAND_LABEL = {
  healthy: 'HEALTHY',
  deleveraging: 'DELEVERAGING BAND',
  liquidatable: 'LIQUIDATABLE',
} as const;

function HealthMeter({ hf, adl }: { hf: Decimal; adl: Decimal }) {
  const liq = scalePct(ONE);
  const adlEnd = scalePct(BigInt(adl.atoms));
  const at = scalePct(BigInt(hf.atoms));
  return (
    <View className="mt-4">
      <View className="h-1.5 w-full flex-row bg-raised" aria-hidden>
        <View style={{ width: `${liq}%` }} className="h-full bg-refused" />
        <View style={{ width: `${adlEnd - liq}%` }} className="h-full bg-signal" />
        <View style={{ flex: 1 }} className="h-full bg-hairline" />
      </View>
      <View className="relative h-3 w-full" aria-hidden>
        <View
          style={{ left: `${at}%`, marginLeft: -1 }}
          className="absolute top-0 h-3 w-0.5 bg-bone"
        />
      </View>
      <View className="mt-1 flex-row justify-between">
        <Num className="text-9 text-ash">0.0×</Num>
        <Num className="text-9 text-ash">1.0× LIQUIDATION</Num>
        <Num className="text-9 text-ash">{factor(adl)} ADL ENDS</Num>
        <Num className="text-9 text-ash">3.0×</Num>
      </View>
    </View>
  );
}

function Risk({ risk }: { risk: RiskSnapshot }) {
  if (risk.status === 'none') {
    return (
      <Panel className="mt-3 gap-2 p-4">
        <Text className="font-mono-medium text-12 text-bone">No margin account yet</Text>
        <Note>Health factor and exposure are read from the account. Fund one to see them.</Note>
        <Link href={routes.onboardingFund} className="pt-1.5">
          <Text className="font-mono text-10 tracking-w14 text-verified">FUND AN ACCOUNT ›</Text>
        </Link>
      </Panel>
    );
  }

  if (risk.status === 'flat') {
    return (
      <Panel className="mt-3 gap-2 p-4">
        <Text className="font-mono-medium text-12 text-bone">No open positions</Text>
        <Note>Nothing is holding margin, so there is no health factor to state.</Note>
        <Line name="COLLATERAL" value={money(risk.collateral)} />
      </Panel>
    );
  }

  const exposure = (
    <View className="gap-2.5">
      {risk.lines.map((l) => (
        <View key={`${l.asset}-${l.side}`} className="gap-1">
          <View className="flex-row justify-between">
            <Text className="font-mono text-11p5 text-bone">
              {l.asset} · {l.side.toUpperCase()}
            </Text>
            <Num className="text-11p5">{money(l.notional)}</Num>
          </View>
          <Num className="text-10 text-ash">
            entry {money(l.entryPrice)} · mark {l.markPrice ? money(l.markPrice) : 'none'}
            {l.pnl ? ` · ${money(l.pnl, true)}` : ''} · {pct(l.shareBps)} of gross
          </Num>
        </View>
      ))}
    </View>
  );

  if (risk.status === 'unpriced') {
    return (
      <Panel className="mt-3 gap-3 p-4">
        <Text className="font-mono-medium text-12 text-bone">Health factor not stated</Text>
        <Note>
          No current price for {risk.missing.join(', ')}. The contract will not guess a stale price,
          and neither does this screen. Exposure is still shown.
        </Note>
        {exposure}
      </Panel>
    );
  }

  const hf = risk.healthFactor;
  return (
    <Panel className="mt-3 p-4">
      <View className="flex-row items-end justify-between gap-3">
        <View className="gap-2">
          <Meta>HEALTH FACTOR</Meta>
          <Num className="font-mono-medium text-31 tracking-t30 leading-[0.9]">
            {hf ? factor(hf) : '—'}
          </Num>
        </View>
        <View className="items-end gap-1.75">
          <View className="flex-row items-center gap-1.75">
            <Dot
              className={cx(
                risk.band === 'healthy' && 'bg-ash',
                risk.band === 'deleveraging' && 'bg-signal',
                risk.band === 'liquidatable' && 'bg-refused',
              )}
            />
            <Text className="font-mono text-10 tracking-w14 text-bone">
              {BAND_LABEL[risk.band]}
            </Text>
          </View>
          <Num className="text-10 text-ash">
            {hf ? 'liquidation below 1.00×' : 'nothing needs maintenance'}
          </Num>
        </View>
      </View>

      {hf ? <HealthMeter hf={hf} adl={risk.adlHealthThreshold} /> : null}

      <View className="mt-4 gap-2.5 border-t border-hairline pt-3.5">
        <Line name="EQUITY" value={money(risk.equity)} />
        <Line name="GROSS EXPOSURE" value={money(risk.gross)} />
        <Line name="NET (LONG − SHORT)" value={money(risk.net, true)} />
        <Line
          name="LEVERAGE"
          value={risk.leverageBps === null ? '—' : factor({ atoms: String(risk.leverageBps), decimals: 4 })}
        />
      </View>

      <Working>
        <Line name="COLLATERAL" value={money(risk.collateral)} />
        <Line name="DEBT" value={`${money(risk.debt)} · not mirrored`} />
        <Line name="UNREALISED P&L" value={money(risk.unrealizedPnl, true)} />
        <Line name="MAINTENANCE" value={`${money(risk.maintenance)} · ${pct(risk.maintenanceBps, 2)} of size`} />
        <Note>
          Health = equity × 1e18 ÷ maintenance, truncated, exactly as MarginAccount.healthFactor
          computes it. Maintenance is the deployment default; the deployed contract&apos;s own value
          is authoritative. Debt is not mirrored off-chain, so it reads zero here.
        </Note>
        {exposure}
      </Working>
    </Panel>
  );
}

function Drawdown({ report }: { report: AnalyticsReport }) {
  const d = report.drawdown;
  if (d.status === 'empty') {
    return (
      <Section title="MAX DRAWDOWN · MODELLED">
        <Note className="mt-3">
          A curve needs at least one executed trade with later price data. There is none yet, so no figure.
        </Note>
      </Section>
    );
  }
  const bars = barHeights(report.equityCurve.map((p) => p.equity));
  return (
    <Section title="MAX DRAWDOWN · MODELLED">
      <View className="mt-3 flex-row items-end justify-between gap-4">
        <View className="gap-2">
          <Num className="font-mono-medium text-26 tracking-t30 leading-[0.9]">
            {pct(d.maxDrawdownBps, 2)}
          </Num>
          <Num className="text-10 text-ash">
            now {pct(d.currentDrawdownBps, 2)} below its peak · {d.points} points
          </Num>
        </View>
      </View>

      <View className="mt-4 h-11 w-full flex-row items-end gap-0.5" aria-hidden>
        {bars.map((h, i) => (
          <View
            key={i}
            style={{ height: `${h}%` }}
            className={cx('flex-1', i === bars.length - 1 ? 'bg-ash' : 'bg-hairline')}
          />
        ))}
      </View>

      <Working>
        <Line name="PEAK" value={`${money(d.peak)} · ${stamp(d.peakAt)}`} />
        <Line name="TROUGH" value={`${money(d.trough)} · ${stamp(d.troughAt)}`} />
        <Note>
          Each executed trade played forward to its own stop, or marked at the latest close, from
          the equity the first one was sized against. A model of the series, not settled fills.
        </Note>
        {report.equityCurve.map((p, i) => (
          <Line key={p.at} name={i === 0 ? `${stamp(p.at)} START` : stamp(p.at)} value={money(p.equity)} />
        ))}
      </Working>
    </Section>
  );
}

function CoolingOff({ report, ruleId }: { report: AnalyticsReport; ruleId: string }) {
  const c = report.coolingOff;
  const [mountedAt] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!c.active) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [c.active]);

  if (!c.active) {
    return (
      <Section title="COOLING-OFF">
        <Note className="mt-3">
          Nothing is cooling off. The pinned rule is the rule in force. A loosening waits{' '}
          {Math.round(c.holdMs / 3_600_000)} hours; a tightening is immediate.
        </Note>
      </Section>
    );
  }

  const remaining = Math.max(0, c.remainingMs - (Date.now() - mountedAt));
  const done = c.holdMs - remaining;
  const progress = Math.min(100, Math.floor((done * 100) / c.holdMs));
  return (
    <Section title="COOLING-OFF · CURRENT HOLD">
      <Link
        href={loosenRoute(ruleId)}
        aria-label="Open the pending change and its countdown"
        className="mt-3 gap-3"
      >
        <View className="flex-row items-end justify-between gap-3">
          <Num className="font-mono-medium text-26 tracking-t30 leading-[0.9]">{clock(remaining)}</Num>
          <Num className="text-10 text-signal">
            {clock(done)} OF {Math.round(c.holdMs / 3_600_000)}H HELD ›
          </Num>
        </View>
        <View className="h-0.75 w-full bg-raised" aria-hidden>
          <View style={{ width: `${progress}%` }} className="h-full bg-signal" />
        </View>
        <Note>
          The current rule stays enforced throughout. Only the hold in force is shown: earlier
          holds are not kept, so no lifetime total is claimed.
        </Note>
      </Link>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 3 · Nansen
// ---------------------------------------------------------------------------

function FlowCell({ label, value }: { label: string; value: Decimal }) {
  const negative = value.atoms.startsWith('-');
  const zero = BigInt(value.atoms) === 0n;
  return (
    <View className="flex-1 basis-[46%] gap-1.75">
      <Meta>{label}</Meta>
      <Num className="text-13p5 font-mono-medium">
        {zero ? '' : negative ? '▼ ' : '▲ '}
        {zero ? money(value) : money(value, true)}
      </Num>
      <Num className={cx('text-9', negative ? 'text-short' : zero ? 'text-ash' : 'text-long')}>
        {zero ? 'FLAT' : negative ? 'NET OUTFLOW' : 'NET INFLOW'}
      </Num>
    </View>
  );
}

/**
 * Owns its own read, so the flow is asked for only when there is a report to put
 * it beside. A signed-in user with no strategy never spends a Nansen call.
 */
function NansenCard({ asset }: { asset: string }) {
  const state = useKanonData().useNansenFlow(asset);
  return (
    <Section
      title="SMART MONEY · NET FLOW"
      right={
        <ExternalLink href={NANSEN_DOCS}>
          <Text className="font-mono text-9 tracking-w14 text-verified">SOURCE · NANSEN ↗</Text>
        </ExternalLink>
      }
    >
      <Panel className="mt-3 p-4">{renderFlow(asset, state)}</Panel>
      <Note className="mt-2">
        Context only. Nansen&apos;s flow is not an input to any predicate and the contract never
        sees it.
      </Note>
    </Section>
  );
}

function renderFlow(asset: string, state: NansenState): ReactNode {
  const label = asset.replace('/', ' / ');
  switch (state.status) {
    case 'loading':
      return (
        <View className="gap-3" aria-busy>
          <View className="h-3 w-2/5 bg-raised" />
          <View className="h-6 w-full bg-raised" />
          <View className="h-6 w-full bg-raised" />
        </View>
      );
    case 'not_connected':
      return (
        <View className="gap-2.5">
          <Text className="font-mono-medium text-12 text-bone">Connect Nansen</Text>
          <Note>
            No Nansen key is set, so no flow is shown for {label}. Set NANSEN_API_KEY in the Convex
            environment to read smart-money net flow. Nothing here is estimated.
          </Note>
          <ExternalLink href={NANSEN_DOCS} className="pt-1">
            <Text className="font-mono text-10 tracking-w14 text-verified">
              NANSEN NET-FLOW API ↗
            </Text>
          </ExternalLink>
        </View>
      );
    case 'unsupported':
      return (
        <View className="gap-2">
          <Text className="font-mono-medium text-12 text-bone">No Nansen token for {label}</Text>
          <Note>
            Nansen reads on-chain tokens. This asset has no honest stand-in to ask about, so none is
            guessed.
          </Note>
        </View>
      );
    case 'no_data':
      return (
        <View className="gap-2">
          <Text className="font-mono-medium text-12 text-bone">No flow reported</Text>
          <Note>
            Nansen has no smart-money flow row for {state.token.symbol} on {state.token.chain}.
          </Note>
        </View>
      );
    case 'error':
      return (
        <View className="gap-2">
          <Text className="font-mono-medium text-12 text-bone">Flow unavailable</Text>
          <Note>{state.message}</Note>
          <Num className="text-9 text-ash">{state.kind.toUpperCase()}</Num>
        </View>
      );
    case 'ok': {
      const f = state.flows;
      return (
        <View>
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="font-mono-medium text-12 text-bone">{label}</Text>
            <Num className="text-10 text-ash">
              read through {state.token.symbol} · {state.token.chain}
            </Num>
          </View>
          <View className="mt-4 flex-row flex-wrap gap-y-4">
            <FlowCell label="1H" value={f.h1} />
            <FlowCell label="24H" value={f.h24} />
            <FlowCell label="7D" value={f.d7} />
            <FlowCell label="30D" value={f.d30} />
          </View>
          <Num className="mt-4 text-10 text-ash">
            USD · {state.traderCount} smart-money traders, 30d · Nansen {stamp(state.fetchedAt)} UTC
          </Num>
          <Working label="SHOW SOURCE">
            <Line name="SOURCE" value="NANSEN · SMART MONEY" />
            <Line name="ENDPOINT" value="POST /api/v1/smart-money/netflow" />
            <Line name="CHAIN" value={state.token.chain} />
            <Line name="TOKEN" value={`${state.token.symbol} ${state.token.address}`} />
            <Line name="REQUEST ID" value={state.requestId ?? 'NOT SENT'} />
            <Line name="FETCHED" value={`${stamp(state.fetchedAt)} UTC`} />
            <Note>
              Nansen&apos;s rolling windows, ending when it was asked. Figures are Nansen&apos;s,
              converted to whole cents and not adjusted.
            </Note>
          </Working>
        </View>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

function Skeleton() {
  return (
    <View className="mt-6 gap-4" aria-busy>
      <View className="h-3 w-1/3 bg-raised" />
      <View className="h-14 w-full bg-panel" />
      <View className="h-10 w-2/3 bg-panel" />
      <View className="h-24 w-full bg-panel" />
    </View>
  );
}

export function AnalyticsScreen() {
  const { useAnalytics, rule } = useKanonData();
  const analytics = useAnalytics();
  const report =
    analytics.status === 'ready' || analytics.status === 'demo' ? analytics.report : null;

  return (
    <Screen rail="bg-hairline" label="12 · ANALYTICS">
      <StatusBar />
      <NavBar
        left="‹ RULE"
        leftHref={routes.home}
        right={analytics.status === 'demo' ? 'ANALYTICS · DEMO DATA' : 'ANALYTICS'}
      />

      <Body>
        {analytics.status === 'loading' ? <Skeleton /> : null}

        {analytics.status === 'empty' ? (
          <View className="mt-10 gap-3">
            <Meta className="tracking-w20">NOTHING TO MEASURE YET</Meta>
            <Text className="font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
              Analytics start with a pinned rule.
            </Text>
            <Note>
              Adherence, what the refusals kept you out of, margin risk and drawdown all read from
              your own setups. There are none yet.
            </Note>
            <Link href={routes.compile} className="pt-2">
              <Text className="font-mono text-10 tracking-w14 text-verified">WRITE A RULE ›</Text>
            </Link>
          </View>
        ) : null}

        {report ? (
          <View className="pb-8">
            <Adherence report={report} />
            <ByPredicate report={report} />

            <Section title="RISK · MARGIN ACCOUNT">
              <Risk risk={report.risk} />
            </Section>
            <Drawdown report={report} />
            <CoolingOff report={report} ruleId={rule.id} />

            <NansenCard asset={report.asset} />

            {/* Last, and modelled. Profit is not the point of this screen. */}
            <View className="mt-9 flex-row items-baseline justify-between border-t border-hairline pt-4">
              <Text className="font-mono text-11 tracking-w06 text-ash">
                P&amp;L · MODELLED · {report.pnl.trades} TRADES
              </Text>
              <Num className="text-11 text-ash">{money(report.pnl.total, true)}</Num>
            </View>
            <Note className="mt-1.5">
              The same play-forward as the drawdown. Not settled fills, and not what this page is for.
            </Note>
          </View>
        ) : null}
      </Body>

      <TabBar active="home" />
    </Screen>
  );
}
