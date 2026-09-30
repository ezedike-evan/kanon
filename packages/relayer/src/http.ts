/** `fetch` with a hard per-request deadline, so one hung connection cannot stall the loop. */
export function withTimeout(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => fetchFn(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
