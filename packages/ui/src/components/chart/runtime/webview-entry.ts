/**
 * The WebView entry point. `scripts/build-chart-runtime.mjs` bundles this file,
 * together with the runtime and lightweight-charts, into one IIFE that
 * `engine.tsx` inlines into the page's HTML, so the native chart needs no
 * network and no CDN.
 *
 * The page defines `window.__KANON_INIT` (palette and font) before this runs
 * and a `<div id="chart">` to mount on. From there the wire format in
 * `lib/chart-protocol.ts` applies: the host calls `window.__kanonChart(command)`
 * and this posts JSON-stringified events to `window.ReactNativeWebView`.
 */
import type { RuntimeCommand, RuntimeEvent, RuntimeInit } from '../../../lib/chart-protocol';
import { createChartRuntime } from './index';

declare global {
  interface Window {
    __KANON_INIT?: RuntimeInit;
    __kanonChart?: (command: RuntimeCommand) => void;
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

const mount = document.getElementById('chart');
const init = window.__KANON_INIT;

if (mount && init) {
  const post = (event: RuntimeEvent) => {
    window.ReactNativeWebView?.postMessage(JSON.stringify(event));
  };
  const runtime = createChartRuntime(mount, init, post);
  window.__kanonChart = (command) => runtime.dispatch(command);
} else {
  window.ReactNativeWebView?.postMessage(
    JSON.stringify({ type: 'error', message: 'chart mount or init missing' }),
  );
}
