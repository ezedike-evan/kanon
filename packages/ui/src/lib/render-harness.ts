import { createElement, Profiler, type ReactElement, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants.js';

/**
 * A headless React renderer, so a test can count renders without a browser.
 *
 * The data layer's job is partly *who re-renders when what changes*, and that
 * is a property of React, not of a pure function: it is measured here by
 * mounting the real hooks under a renderer that draws nothing, wrapping each
 * consumer in a `Profiler`, and counting commits.
 */

let priority: number = DefaultEventPriority;

const noop = () => {};
const host: any = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  createInstance: () => ({}),
  createTextInstance: () => ({}),
  appendInitialChild: noop,
  appendChild: noop,
  appendChildToContainer: noop,
  insertBefore: noop,
  insertInContainerBefore: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  finalizeInitialChildren: () => false,
  commitUpdate: noop,
  commitTextUpdate: noop,
  getRootHostContext: () => ({}),
  getChildHostContext: (c: unknown) => c,
  shouldSetTextContent: () => false,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  preparePortalMount: noop,
  getPublicInstance: (i: unknown) => i,
  clearContainer: noop,
  hideInstance: noop,
  unhideInstance: noop,
  hideTextInstance: noop,
  unhideTextInstance: noop,
  detachDeletedInstance: noop,
  getCurrentUpdatePriority: () => priority,
  setCurrentUpdatePriority: (p: number) => {
    priority = p;
  },
  resolveUpdatePriority: () => (priority === NoEventPriority ? DefaultEventPriority : priority),
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  requestPostPaintCallback: noop,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: { $$typeof: Symbol.for('react.context'), _currentValue: null, _currentValue2: null, Provider: null, Consumer: null },
  resetFormInstance: noop,
  bindToConsole: (_m: string, args: unknown[]) => Function.prototype.bind.apply(console.error, [console, ...args] as never),
  beforeActiveInstanceBlur: noop,
  afterActiveInstanceBlur: noop,
  prepareScopeUpdate: noop,
  getInstanceFromNode: () => null,
  getInstanceFromScope: () => null,
};

const reconciler = Reconciler(host);

/** Lets scheduled renders and effects run: a few macrotasks is enough for a sync-lane cascade. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    reconciler.flushSyncWork?.();
    await new Promise((r) => setTimeout(r, 0));
  }
}

export interface Harness {
  /** Commits per `counted` id since the last `reset`. */
  counts: Record<string, number>;
  reset(): void;
  /** Wraps children so every commit of the subtree is counted under `id`. */
  counted(id: string, children: ReactNode): ReactElement;
  render(element: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

export function createHarness(): Harness {
  const counts: Record<string, number> = {};
  const errors: unknown[] = [];
  const onError = (e: unknown) => {
    errors.push(e);
  };
  const container = reconciler.createContainer({}, 0, null, false, null, 'kanon', onError, onError, onError, noop, null);
  return {
    counts,
    reset: () => {
      for (const k of Object.keys(counts)) counts[k] = 0;
    },
    counted: (id, children) =>
      createElement(
        Profiler,
        {
          id,
          onRender: () => {
            counts[id] = (counts[id] ?? 0) + 1;
          },
        },
        children,
      ),
    async render(el) {
      reconciler.updateContainerSync(el, container, null, null);
      await settle();
      // A component that throws unmounts the whole tree; say so instead of counting nothing.
      if (errors.length > 0) throw errors[0];
    },
    async unmount() {
      reconciler.updateContainerSync(null, container, null, null);
      await settle();
    },
  };
}
