/**
 * Types for the core flow: compile, review, pin, propose, refuse, amend.
 *
 * Kept apart from `data.tsx` so the pure mapping in `live-map.ts` and the tests
 * that pin it down can import them without dragging in React or the demo
 * fixtures.
 */

import type { SpecChange } from '@kanon/spec';

/** `demo` renders fixtures. `live` renders the signed-in user's own rows. */
export type DataMode = 'demo' | 'live';

export type CompilerStatus = 'idle' | 'compiling' | 'failed';

/**
 * Whether pinning can happen on this device right now, stated honestly. Every
 * state other than `ready` blocks the sign button: a ceremony that reports a
 * pin it did not make would be the lie the product exists to prevent.
 */
export type PinAvailability =
  | { state: 'ready' }
  | { state: 'not_deployed'; message: string }
  | { state: 'no_wallet'; message: string }
  | { state: 'demo'; message: string };

export type PinFailure =
  | 'not_deployed'
  | 'no_wallet'
  | 'no_draft'
  | 'not_reviewed'
  | 'rejected'
  | 'failed'
  | 'demo';

export type PinOutcome =
  | { ok: true; txHash: string }
  | { ok: false; reason: PinFailure; message: string };

export type EditOutcome = { ok: true } | { ok: false; error: string };

export type ProposalRun =
  | { status: 'proposed'; tradeId: string }
  | { status: 'refused'; tradeId: string }
  | { status: 'unavailable' | 'blocked' | 'failed'; message: string };

export type TradeActionOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Throwing the autopilot switch for a rule. `on` is what the server says it is
 * now. A switch that was not thrown comes back with a sentence a person can
 * read; it is never a rejection.
 */
export type AutopilotOutcome =
  | { ok: true; on: boolean }
  | { ok: false; reason: 'demo' | 'no_rule' | 'failed'; message: string };

export interface AmendmentPreview {
  kind: 'none' | 'immediate' | 'cooling_off';
  changes: SpecChange[];
  cooldownSeconds: number;
}

export type AmendOutcome =
  | { ok: true; kind: 'immediate' | 'cooling_off' }
  | { ok: false; message: string };

/** The review screen is showing one of these, and the footer changes with it. */
export type ReviewMode =
  /** Fixtures. Pinning does nothing real. */
  | 'demo'
  /** A compiled draft awaiting sign-off. */
  | 'draft'
  /** A pinned rule, with edits staged. Tightening is immediate, loosening waits. */
  | 'amend'
  /** Nothing to review yet. */
  | 'empty';
