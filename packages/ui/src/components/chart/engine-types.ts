import type { RuntimeCommand, RuntimeEvent, RuntimeInit } from '../../lib/chart-protocol';

/** What the host can do to a mounted engine. Commands sent before the runtime is ready are queued. */
export interface ChartEngineHandle {
  dispatch(command: RuntimeCommand): void;
}

/**
 * The two engines (`engine.web.tsx`, `engine.tsx`) are transports and nothing
 * else: they mount the shared runtime, carry `RuntimeCommand`s in and
 * `RuntimeEvent`s out, and hold no chart logic of their own.
 */
export interface ChartEngineProps {
  /** Read once at mount. Later palette changes travel as `theme` commands. */
  init: RuntimeInit;
  onEvent: (event: RuntimeEvent) => void;
}
