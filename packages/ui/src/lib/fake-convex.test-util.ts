import { useEffect, useSyncExternalStore } from 'react';

/**
 * A fake Convex for render tests: a store of query results keyed by function
 * name, `emit` to push a new result (as a live query would), and a count of
 * which queries are subscribed at the moment and which actions were called.
 * A mutation records what it was called with and answers `{}` unless
 * `onMutation` gives it something else to do, a throw included. An action does
 * the same, answering `{ outcomes: {} }` unless `onAction` says otherwise.
 */
export function createFakeConvex() {
  const results = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const subscribed = new Map<string, number>();
  const actionCalls: Record<string, number> = {};
  const mutationCalls: Array<{ name: string; args: unknown }> = [];
  const mutationAnswers = new Map<string, (args: any) => unknown>();
  const actionArgs: Array<{ name: string; args: unknown }> = [];
  const actionAnswers = new Map<string, (args: any) => unknown>();

  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };

  const api: any = new Proxy(
    {},
    { get: (_, mod) => new Proxy({}, { get: (_2, fn) => ({ __name: `${String(mod)}.${String(fn)}` }) }) },
  );

  function useQuery(ref: any, args: unknown) {
    const name: string = ref.__name;
    const skipped = args === 'skip';
    useEffect(() => {
      if (skipped) return;
      subscribed.set(name, (subscribed.get(name) ?? 0) + 1);
      return () => {
        subscribed.set(name, (subscribed.get(name) ?? 1) - 1);
      };
    }, [name, skipped]);
    const value = useSyncExternalStore(subscribe, () => results.get(name), () => undefined);
    return skipped ? undefined : value;
  }

  // Convex returns the same function for the same reference on every render; so does this,
  // or every consumer of one would look like it had changed.
  const mutations = new Map<string, (args?: unknown) => Promise<unknown>>();
  const actions = new Map<string, (args?: unknown) => Promise<unknown>>();

  return {
    api,
    hooks: {
      useQuery,
      useMutation: (ref: any) => {
        if (!mutations.has(ref.__name)) {
          mutations.set(ref.__name, async (args) => {
            mutationCalls.push({ name: ref.__name, args });
            const answer = mutationAnswers.get(ref.__name);
            return answer ? answer(args) : {};
          });
        }
        return mutations.get(ref.__name)!;
      },
      useAction: (ref: any) => {
        if (!actions.has(ref.__name)) {
          actions.set(ref.__name, async (args) => {
            actionCalls[ref.__name] = (actionCalls[ref.__name] ?? 0) + 1;
            actionArgs.push({ name: ref.__name, args });
            const answer = actionAnswers.get(ref.__name);
            return answer ? answer(args) : { outcomes: {} };
          });
        }
        return actions.get(ref.__name)!;
      },
    },
    emit(name: string, value: unknown) {
      results.set(name, value);
      for (const l of [...listeners]) l();
    },
    /** Queries with at least one live subscriber, sorted. */
    subscribedQueries: () => [...subscribed].filter(([, n]) => n > 0).map(([k]) => k).sort(),
    actionCalls,
    /** Every mutation call so far, in order, with its arguments. */
    mutationCalls,
    /** What a mutation answers from now on: a value, or a throw. */
    onMutation(name: string, answer: (args: any) => unknown) {
      mutationAnswers.set(name, answer);
    },
    /** Every action call so far, in order, with its arguments. */
    actionArgs,
    /** What an action answers from now on: a value, or a throw. */
    onAction(name: string, answer: (args: any) => unknown) {
      actionAnswers.set(name, answer);
    },
  };
}
