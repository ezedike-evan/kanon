/**
 * The native engine: the shared runtime inside a `react-native-webview`.
 *
 * lightweight-charts is a canvas/DOM library with no React Native build, so on
 * a device it can only run in a WebView's own engine. The runtime is bundled
 * with the library into one string (`runtime-bundle.generated.ts`, built by
 * `scripts/build-chart-runtime.mjs`) and inlined into the page, so the chart
 * needs no network. Nothing else lives in the HTML.
 *
 * Bridge, both ways JSON (wire format in `lib/chart-protocol.ts`):
 *   host -> page   webview.injectJavaScript("window.__kanonChart(<command>);true;")
 *   page -> host   window.ReactNativeWebView.postMessage(<event>) -> onMessage
 * Commands sent before the page reports `ready` are queued and flushed in
 * order. The page throttles its own crosshair events, so nothing per-frame
 * crosses the bridge.
 *
 * NOT verified on a device from this environment: the same runtime is verified
 * in a browser, but the WebView transport below is only typechecked.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { parseRuntimeEvent, type RuntimeCommand, type RuntimeInit } from '../../lib/chart-protocol';
import type { ChartEngineHandle, ChartEngineProps } from './engine-types';
import { CHART_RUNTIME_BUNDLE } from './runtime-bundle.generated';

/** JSON that is safe to embed in a script: `</script>` and the two JS line separators are escaped. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}

function buildHtml(init: RuntimeInit): string {
  const bundle = CHART_RUNTIME_BUNDLE.replace(/<\/script/gi, '<\\/script');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #chart { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; background: ${init.palette.background}; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
</style>
</head>
<body>
<div id="chart"></div>
<script>window.__KANON_INIT = ${safeJson(init)};</script>
<script>${bundle}</script>
</body>
</html>`;
}

const ChartEngine = forwardRef<ChartEngineHandle, ChartEngineProps>(function ChartEngine(
  { init, onEvent },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const ready = useRef(false);
  const queue = useRef<RuntimeCommand[]>([]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Built once: a palette change is a `theme` command, never a page reload.
  const html = useMemo(() => buildHtml(init), []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((command: RuntimeCommand) => {
    webRef.current?.injectJavaScript(`window.__kanonChart(${safeJson(command)});true;`);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      dispatch(command) {
        if (ready.current) send(command);
        else queue.current.push(command);
      },
    }),
    [send],
  );

  const onMessage = useCallback(
    (message: WebViewMessageEvent) => {
      const event = parseRuntimeEvent(message.nativeEvent.data);
      if (!event) return; // A malformed bridge message never crashes the chart.
      if (event.type === 'ready') {
        ready.current = true;
        for (const command of queue.current.splice(0)) send(command);
      }
      onEventRef.current(event);
    },
    [send],
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        onMessage={onMessage}
        style={{ flex: 1, backgroundColor: init.palette.background }}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        javaScriptEnabled
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        automaticallyAdjustContentInsets={false}
        hideKeyboardAccessoryView
        onContentProcessDidTerminate={() => {
          // iOS killed the page under memory pressure: wait for a fresh `ready` and let the host resync.
          ready.current = false;
          webRef.current?.reload();
        }}
      />
    </View>
  );
});

export default ChartEngine;
