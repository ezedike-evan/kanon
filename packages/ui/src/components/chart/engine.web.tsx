/**
 * The web engine: mounts the shared runtime on a DOM node.
 *
 * `.web.tsx` wins over `.tsx` in this repo's webpack resolution
 * (`apps/web/next.config.ts`). `react-native-web` forwards a `View` ref to the
 * real host `<div>`, so this stays on the RN primitive per CLAUDE.md.
 *
 * All chart logic is in `./runtime`; this file only creates it once, forwards
 * commands in and events out, and destroys it on unmount.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type ComponentRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { RuntimeEvent } from '../../lib/chart-protocol';
import type { ChartEngineHandle, ChartEngineProps } from './engine-types';
import { createChartRuntime, type ChartRuntime } from './runtime';

const ChartEngine = forwardRef<ChartEngineHandle, ChartEngineProps>(function ChartEngine(
  { init, onEvent },
  ref,
) {
  const nodeRef = useRef<ComponentRef<typeof View>>(null);
  const runtimeRef = useRef<ChartRuntime | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const initRef = useRef(init);

  useImperativeHandle(ref, () => ({ dispatch: (command) => runtimeRef.current?.dispatch(command) }), []);

  useEffect(() => {
    const node = nodeRef.current as unknown as HTMLElement | null;
    if (!node) return;
    // The runtime announces `ready` while it is being constructed, before this
    // effect has the handle. Hold events until it is assigned.
    let constructing = true;
    const held: RuntimeEvent[] = [];
    const runtime = createChartRuntime(node, initRef.current, (event) => {
      if (constructing) held.push(event);
      else onEventRef.current(event);
    });
    runtimeRef.current = runtime;
    constructing = false;
    for (const event of held) onEventRef.current(event);
    // A hook for browser-driven checks; never present in a production build.
    if (process.env.NODE_ENV !== 'production') {
      (node as unknown as { __kanonRuntime?: ChartRuntime }).__kanonRuntime = runtime;
    }
    return () => {
      runtime.destroy();
      runtimeRef.current = null;
    };
  }, []);

  return <View ref={nodeRef} style={StyleSheet.absoluteFill} />;
});

export default ChartEngine;
