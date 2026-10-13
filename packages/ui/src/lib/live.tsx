import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyParamEdit,
  specHash as hashSpec,
  type Decimal,
  type StrategySpec,
} from '@kanon/spec';
import {
  demoDataSource,
  type BlockedLogData,
  type KanonDataSource,
  type ShareCardData,
  type TranscriptTurn,
} from './data';
import { switchAutopilot } from './autopilot';
import type {
  AmendOutcome,
  AutopilotOutcome,
  CompilerStatus,
  EditOutcome,
  PinOutcome,
  ProposalRun,
  ReviewMode,
  TradeActionOutcome,
} from './flow-types';
import {
  NO_PRICE,
  blockedLogFromTrades,
  compilerData,
  coolingOffFromStrategy,
  emptyRule,
  homeFromTrades,
  pickStrategies,
  pinningData,
  proposalFromTrade,
  refusalFromTrade,
  reviewData,
  ruleFromStrategy,
  safeSpec,
  shareCardFromStrategy,
  tradeDetailFromTrade,
  turn,
  type LiveModelled,
  type LiveStrategy,
  type LiveTrade,
} from './live-map';
import {
  runAmendFlow,
  runFinalizeFlow,
  runPinFlow,
  runWithdrawFlow,
  type UnsavedPin,
} from './flows';
import { buildPinTarget, type PinClient, type PinTargetResult } from './pin';

/**
 * The live `KanonDataSource`, built once for both clients.
 *
 * `packages/ui` has no dependency on Convex or a chain library, so each app
 * hands this hook a `LiveBackend`: the rows it has already subscribed to, the
 * actions it can call, and a `PinClient`. Everything a screen renders in the
 * core flow (compile, review, pin, propose, refuse, amend) is decided here, in
 * one place, so web and mobile cannot drift.
 *
 * Signed out, or signed in with no `users` row yet, this returns the demo
 * source unchanged. Live data never blends with fixtures: a signed-in user
 * with nothing pinned sees an empty state, not someone else's rule.
 */

export type CompileResult =
  | { status: 'compiled'; spec: StrategySpec; reply: string; specHash: string }
  | { status: 'rejected'; reply: string; reason: string }
  | { status: 'failed'; error: string }
  | { status: 'rate_limited'; retryAfterMs: number; message: string };

export type RunProposerResult =
  | { status: 'proposed'; tradeId: string }
  | { status: 'refused'; tradeId: string }
  | { status: 'unavailable'; reason: string; message: string }
  | { status: 'blocked'; message: string };

export interface LiveActions {
  compile(args: {
    prompt: string;
    previousSpec?: unknown;
    conversationHistory?: Array<{ from: string; text: string }>;
  }): Promise<CompileResult>;
  saveDraft(args: {
    strategyId?: string;
    spec: StrategySpec;
  }): Promise<{ strategyId: string; specHash: string }>;
  pinStrategy(args: {
    strategyId: string;
    specHash: string;
    predicatesCommitment: string;
    series: string;
    bondAtoms: Decimal;
    txHash: string;
    chainId: number;
    registryAddress: string;
    chainStrategyId: string;
  }): Promise<unknown>;
  amendStrategy(args: {
    strategyId: string;
    nextSpec: StrategySpec;
    predicatesCommitment: string;
    series: string;
    txHash: string;
    chainCooldownEndsAt?: number;
  }): Promise<{ kind: 'none' | 'immediate' | 'cooling_off' }>;
  finalizeAmendment(args: { strategyId: string; txHash: string }): Promise<unknown>;
  withdrawAmendment(args: { strategyId: string; txHash: string }): Promise<unknown>;
  runProposer(args: { strategyId: string }): Promise<RunProposerResult>;
  blockedReport(args: {
    strategyId: string;
  }): Promise<{ outcomes: Record<string, LiveModelled> }>;
  undoTrade(args: { tradeId: string }): Promise<{ ok: boolean; reason?: string }>;
  confirmTrade(args: { tradeId: string }): Promise<{ ok: boolean; reason?: string }>;
  /** `strategies:setAutopilot`. Throws unless the strategy is pinned or cooling off. */
  setAutopilot(args: { strategyId: string; on: boolean }): Promise<{ autopilot: boolean }>;
}

export interface LiveBackend {
  /** The Convex `users` row for the signed-in Privy user. Undefined means demo. */
  userId: string | undefined;
  strategies: LiveStrategy[] | undefined;
  /** The trades of the active strategy, from the caller's own subscription. */
  trades: LiveTrade[] | undefined;
  actions: LiveActions;
  pinClient: PinClient;
  /** `createChartReads(...)`, spread in unchanged. */
  chartReads: Pick<KanonDataSource, 'useSeries' | 'useChartMarkers'>;
  /** `createPredictReads(...)`, spread in unchanged. Absent, the Predict tab stays on its demo cards. */
  predictReads?: Pick<KanonDataSource, 'usePredict'> | undefined;
}

const NOT_PINNED_SHARE: ShareCardData = {
  window: 'NOT PINNED',
  summary: [],
  adherenceBps: 0,
  verifiedPnlBps: null,
  taken: 0,
  blocked: 0,
  overrides: 0,
  url: '',
  disclaimer: 'Pin a rule to get a card anyone can verify.',
  specHash: '',
};

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

const REFRESH_BLOCKED_MS = 5 * 60 * 1000;

export function useLiveKanonSource(backend: LiveBackend): KanonDataSource {
  const { userId, strategies, trades, actions, pinClient, chartReads, predictReads } = backend;

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [compileStatus, setCompileStatus] = useState<CompilerStatus>('idle');
  const [compileError, setCompileError] = useState<string | undefined>(undefined);
  /** The user has sent a compile message this session, so the draft is what they are reviewing. */
  const [composing, setComposing] = useState(false);
  const [localDraft, setLocalDraft] = useState<StrategySpec | null>(null);
  const [prevDraft, setPrevDraft] = useState<StrategySpec | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [staged, setStaged] = useState<StrategySpec | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | undefined>(undefined);
  const [pinBusy, setPinBusy] = useState(false);
  const [minBond, setMinBond] = useState<Decimal | null>(null);
  const [draftHash, setDraftHash] = useState('');
  const [draftTarget, setDraftTarget] = useState<PinTargetResult | null>(null);
  const [focusTradeId, setFocusTradeId] = useState<string | undefined>(undefined);
  /** A pin the chain accepted whose row has not been saved yet. Retried, never re-sent. */
  const unsavedPin = useRef<UnsavedPin['current']>(null);
  const unsaved: UnsavedPin = useMemo(
    () => ({
      get current() {
        return unsavedPin.current;
      },
      set current(value) {
        unsavedPin.current = value;
      },
    }),
    [],
  );

  const picked = useMemo(() => pickStrategies(strategies), [strategies]);
  const serverDraft = useMemo(() => safeSpec(picked.draft?.pendingSpec), [picked.draft]);
  const activeSpec = useMemo(() => safeSpec(picked.active?.spec), [picked.active]);
  const draftSpec = localDraft ?? serverDraft;

  const mode: ReviewMode =
    draftSpec && (composing || !activeSpec) ? 'draft' : activeSpec ? 'amend' : 'empty';
  const reviewedSpec = mode === 'draft' ? draftSpec : mode === 'amend' ? (staged ?? activeSpec) : null;

  // A draft that was pinned becomes the active strategy: nothing local should outlive that.
  const activeId = picked.active?._id;
  useEffect(() => {
    setStaged(null);
  }, [activeId, picked.active?.specHash]);

  useEffect(() => {
    let live = true;
    if (!draftSpec) {
      setDraftHash('');
      setDraftTarget(null);
      return;
    }
    void hashSpec(draftSpec).then((h) => {
      if (live) setDraftHash(h);
    });
    // Hash, predicates commitment and series address: what the pin will carry, or why it cannot.
    void buildPinTarget(draftSpec, pinClient.series).then((t) => {
      if (live) setDraftTarget(t);
    });
    return () => {
      live = false;
    };
  }, [draftSpec, pinClient]);

  // The registry's own minimum bond, read from it. Nothing is shown until it has been.
  const availabilityState = pinClient.availability().state;
  useEffect(() => {
    let live = true;
    if (availabilityState !== 'ready') {
      setMinBond(null);
      return;
    }
    pinClient
      .readMinBond()
      .then((bond) => live && setMinBond(bond))
      .catch(() => live && setMinBond(null));
    return () => {
      live = false;
    };
  }, [pinClient, availabilityState]);

  // The blocked log's modelled outcomes are not worked out here. That is a server
  // action over up to 500 candles, and this hook runs on every screen: it lives in
  // `useBlockedLog`, which runs only while the blocked log is on screen.
  const refusedCount = (trades ?? []).filter((t) => t.status === 'refused').length;
  /** The last modelled outcomes, so reopening the log inside the refresh window does not call the action again. */
  const reportCache = useRef<{ key: string; at: number; outcomes: Record<string, LiveModelled> } | null>(null);

  return useMemo<KanonDataSource>(() => {
    // The same hooks in the same order whatever the session. Signed in is not known until
    // `users.me` answers, so a screen mounted on load sees this source change from demo to live
    // under it, and a hook that changed count between the two would crash it.
    const list = trades ?? [];
    function useBlockedLog(): BlockedLogData {
      const cacheKey = `${activeId}:${refusedCount}`;
      const cachedFor = (key: string) => {
        const c = reportCache.current;
        return c && c.key === key && Date.now() - c.at < REFRESH_BLOCKED_MS ? c.outcomes : undefined;
      };
      const [report, setReport] = useState<Record<string, LiveModelled> | undefined>(() => cachedFor(cacheKey));
      useEffect(() => {
        if (!userId || !activeId) {
          setReport(undefined);
          return;
        }
        if (refusedCount === 0) {
          setReport({});
          return;
        }
        let live = true;
        const run = () =>
          actions
            .blockedReport({ strategyId: activeId })
            .then((r) => {
              reportCache.current = { key: cacheKey, at: Date.now(), outcomes: r.outcomes };
              if (live) setReport(r.outcomes);
            })
            .catch(() => live && setReport((prev) => prev ?? {}));
        const cached = cachedFor(cacheKey);
        if (cached) setReport(cached);
        else void run();
        const id = setInterval(run, REFRESH_BLOCKED_MS);
        return () => {
          live = false;
          clearInterval(id);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [actions, userId, activeId, refusedCount, cacheKey]);

      const live = useMemo(
        () => blockedLogFromTrades({ trades: list, spec: activeSpec, report, now: Date.now() }),
        // `list` and `activeSpec` are what this source was built from; a new source is a new closure.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [report, list, activeSpec],
      );
      return userId ? live : demoDataSource.useBlockedLog();
    }


    if (!userId) return { ...demoDataSource, ...chartReads, ...predictReads, useBlockedLog };

    const now = Date.now();
    const newestFirst = [...list].sort((a, b) => b.createdAt - a.createdAt);
    const focus = newestFirst.find((t) => t._id === focusTradeId);
    const proposalTrade =
      focus && focus.status !== 'refused' ? focus : newestFirst.find((t) => t.status !== 'refused');
    const refusalTrade =
      focus && focus.status === 'refused' ? focus : newestFirst.find((t) => t.status === 'refused');

    const strategy = picked.active;
    const rule =
      strategy && activeSpec
        ? ruleFromStrategy({ strategy, spec: activeSpec, ordinal: picked.ordinalOf(strategy._id) })
        : emptyRule(picked.nextOrdinal);

    const setBothDrafts = (next: StrategySpec, before: StrategySpec | null) => {
      setPrevDraft(before);
      setLocalDraft(next);
      setAcknowledged(false);
    };

    async function persistDraft(spec: StrategySpec): Promise<void> {
      if (!userId) return;
      const saved = await actions.saveDraft({
        ...(picked.draft ? { strategyId: picked.draft._id } : {}),
        spec,
      });
      // The row now exists on the server; its subscription will carry the same spec.
      void saved;
    }

    // --- Compiler -----------------------------------------------------------
    async function sendCompilerMessage(text: string): Promise<void> {
      const prompt = text.trim();
      if (!prompt || compileStatus === 'compiling' || !userId) return;
      const history = transcript.map((t) => ({ from: t.from, text: t.text }));
      setComposing(true);
      setCompileError(undefined);
      setCompileStatus('compiling');
      setTranscript((prev) => [...prev, turn('YOU', prompt, Date.now())]);
      try {
        const result = await actions.compile({
          prompt,
          ...(draftSpec ? { previousSpec: draftSpec } : {}),
          conversationHistory: history,
        });
        if (result.status === 'compiled') {
          setBothDrafts(result.spec, draftSpec);
          setTranscript((prev) => [...prev, turn('KANON', result.reply, Date.now())]);
          try {
            await persistDraft(result.spec);
            setCompileStatus('idle');
          } catch (err) {
            setCompileStatus('failed');
            setCompileError(`The draft compiled but could not be saved. ${errorText(err, '')}`.trim());
          }
        } else if (result.status === 'rejected') {
          // The request was not expressible as one of the three predicates. That is an answer, not a fault.
          setTranscript((prev) => [...prev, turn('KANON', result.reply, Date.now())]);
          setCompileStatus('idle');
        } else if (result.status === 'rate_limited') {
          setCompileStatus('failed');
          setCompileError(result.message);
        } else {
          setCompileStatus('failed');
          setCompileError(result.error);
        }
      } catch (err) {
        setCompileStatus('failed');
        setCompileError(errorText(err, 'The compiler could not be reached.'));
      }
    }

    // --- Review -------------------------------------------------------------
    function editParam(key: string, value: string | number): EditOutcome {
      const base = mode === 'draft' ? draftSpec : mode === 'amend' ? (staged ?? activeSpec) : null;
      if (!base) return { ok: false, error: 'There is no spec to edit.' };
      const edited = applyParamEdit(base, key, value);
      if (!edited.ok) return { ok: false, error: edited.error };

      setReviewError(undefined);
      if (mode === 'draft') {
        setBothDrafts(edited.spec, base);
        persistDraft(edited.spec).catch((err) =>
          setReviewError(`The edit could not be saved. ${errorText(err, '')}`.trim()),
        );
      } else {
        setStaged(edited.spec);
      }
      return { ok: true };
    }

    async function submitAmendment(): Promise<AmendOutcome> {
      setReviewBusy(true);
      setReviewError(undefined);
      const out = await runAmendFlow({
        userId,
        strategy,
        current: activeSpec,
        staged,
        pinClient,
        actions,
      });
      setReviewBusy(false);
      if (out.ok) setStaged(null);
      else setReviewError(out.message);
      return out;
    }

    // --- Pinning ------------------------------------------------------------
    async function pinStrategy(): Promise<PinOutcome> {
      setPinBusy(true);
      try {
        const out = await runPinFlow({
          userId,
          spec: draftSpec,
          draft: picked.draft,
          acknowledged,
          pinClient,
          actions,
          unsaved,
        });
        if (out.ok) {
          setLocalDraft(null);
          setPrevDraft(null);
          setAcknowledged(false);
          setComposing(false);
        }
        return out;
      } finally {
        setPinBusy(false);
      }
    }

    // --- Proposals ----------------------------------------------------------
    async function requestProposal(): Promise<ProposalRun> {
      if (!userId || !strategy) {
        return { status: 'blocked', message: 'Pin a rule before it can judge a trade.' };
      }
      try {
        const out = await actions.runProposer({ strategyId: strategy._id });
        if (out.status === 'proposed' || out.status === 'refused') {
          setFocusTradeId(out.tradeId);
          return out.status === 'proposed'
            ? { status: 'proposed', tradeId: out.tradeId }
            : { status: 'refused', tradeId: out.tradeId };
        }
        return { status: out.status, message: out.message };
      } catch (err) {
        return { status: 'failed', message: errorText(err, 'The check could not run.') };
      }
    }

    async function tradeAction(
      fn: (a: { tradeId: string }) => Promise<{ ok: boolean; reason?: string }>,
    ): Promise<TradeActionOutcome> {
      if (!userId || !proposalTrade) return { ok: false, reason: 'no_trade' };
      // An autopilot proposal is the gateway's to open: there is nothing to confirm and no window to undo it in.
      if (proposalTrade.origin === 'autopilot') return { ok: false, reason: 'autopilot' };
      try {
        const out = await fn({ tradeId: proposalTrade._id });
        return out.ok ? { ok: true } : { ok: false, reason: out.reason ?? 'unavailable' };
      } catch (err) {
        return { ok: false, reason: errorText(err, 'failed') };
      }
    }

    // --- Autopilot ----------------------------------------------------------
    // By id, not for the active rule alone: a rule that was replaced while autopilot was on for it
    // is still being judged, and its owner has to be able to turn that off.
    const setAutopilot = (strategyId: string, on: boolean): Promise<AutopilotOutcome> =>
      switchAutopilot({ userId, strategyId, on, setAutopilot: actions.setAutopilot });

    // --- Cooling-off --------------------------------------------------------
    const finalizeCoolingOff = () => runFinalizeFlow({ userId, strategy, pinClient, actions });
    const withdrawCoolingOff = () => runWithdrawFlow({ userId, strategy, activeSpec, pinClient, actions });

    const ordinal = picked.draft ? picked.ordinalOf(picked.draft._id) : picked.nextOrdinal;

    return {
      ...demoDataSource,
      ...chartReads,
      ...predictReads,
      mode: 'live',
      hasPinned: Boolean(strategy && activeSpec),
      hasDraft: draftSpec !== null,
      rule,
      home: homeFromTrades(list, NO_PRICE),
      latestTradeId: newestFirst[0]?._id ?? '',
      refusal: refusalTrade && activeSpec ? refusalFromTrade(refusalTrade, activeSpec) : null,
      compiler: compilerData({
        ordinal,
        transcript,
        spec: draftSpec,
        previous: prevDraft,
        status: compileStatus,
        error: compileError,
      }),
      sendCompilerMessage,
      review: reviewData({
        spec: reviewedSpec,
        baseline: mode === 'amend' ? activeSpec : null,
        mode,
        acknowledged,
        busy: reviewBusy,
        error: reviewError,
      }),
      editParam,
      acknowledgeReview: (read) => setAcknowledged(read),
      submitAmendment,
      pinning: pinningData({
        specHash: draftHash,
        target: draftTarget,
        contract: pinClient.registryAddress,
        minBond,
        nativeSymbol: pinClient.nativeSymbol,
        availability: pinClient.availability(),
        busy: pinBusy,
      }),
      pinStrategy,
      proposal: proposalTrade && activeSpec ? proposalFromTrade(proposalTrade, activeSpec, now) : null,
      requestProposal,
      confirmProposal: () => tradeAction(actions.confirmTrade),
      undoProposal: () => tradeAction(actions.undoTrade),
      setAutopilot,
      tradeDetail(id: string) {
        const found = list.find((t) => String(t._id) === id);
        return found && activeSpec ? tradeDetailFromTrade(found, activeSpec) : null;
      },
      useBlockedLog,
      coolingOff: coolingOffFromStrategy(strategy, now),
      finalizeCoolingOff,
      withdrawCoolingOff,
      shareCard:
        strategy && activeSpec
          ? shareCardFromStrategy({ strategy, spec: activeSpec, trades: list, now })
          : NOT_PINNED_SHARE,
    };
    // `chartReads` is rebuilt by the caller each render; the hooks it holds are stable in behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    userId,
    trades,
    picked,
    activeSpec,
    draftSpec,
    prevDraft,
    staged,
    mode,
    reviewedSpec,
    transcript,
    compileStatus,
    compileError,
    acknowledged,
    reviewBusy,
    reviewError,
    pinBusy,
    minBond,
    draftHash,
    draftTarget,
    focusTradeId,
    actions,
    pinClient,
    availabilityState,
    chartReads.useSeries,
    chartReads.useChartMarkers,
    predictReads?.usePredict,
  ]);
}
