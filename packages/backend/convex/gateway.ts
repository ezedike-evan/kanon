import { internalAction } from "./_generated/server";

/**
 * Asks the gateway whether it is alive, on a timer (`crons.ts`).
 *
 * The gateway closes a timed trade when its time is up, so it has to be awake
 * when that time comes, whether or not anybody has the app open. A host that
 * puts an idle service to sleep would leave such a trade open until the next
 * visitor arrived. A request every few minutes keeps it awake, and one that
 * finds it asleep wakes it, which is when it picks up the trades it still has
 * to close.
 *
 * `GATEWAY_URL` is the gateway's public address. Unset, this does nothing.
 * The request goes to the gateway, not to the venue, so the venue's refusal of
 * this backend's region does not come into it.
 */
export const ping = internalAction({
  args: {},
  handler: async (): Promise<null> => {
    const base = process.env.GATEWAY_URL?.trim().replace(/\/+$/, "");
    if (!base || !/^https?:\/\//.test(base)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await fetch(`${base}/livez`, { signal: controller.signal });
    } catch {
      // Not answering is the host's to put right. The next request tries again.
    } finally {
      clearTimeout(timer);
    }
    return null;
  },
});
