/**
 * A rule's exits: the stop and the target, each a distance from entry.
 *
 * A rule is compiled, pinned, amended and tested only when the user stated
 * both. A compiler that chose either would be writing the user's risk for them,
 * and a test with no target cannot say what a win is. So an exit the compiler
 * inferred counts as missing, exactly like one that is absent.
 *
 * `risk.targetDistanceBps` is optional in the schema only so a spec pinned
 * before targets existed still parses and keeps its hash. It is never optional
 * here.
 */

import type { StrategySpec } from './spec';

/** An exit by the name it carries in the parametric view. */
export type ExitName = 'stop_distance' | 'target_distance';

/** Where each exit lives in the review's parameter table. */
export const EXIT_PARAM_KEY: Record<ExitName, string> = {
  stop_distance: 'risk.stopDistanceBps',
  target_distance: 'risk.targetDistanceBps',
};

/** The exits the user has not stated, stop first. Empty when the rule may be pinned. */
export function missingExits(spec: StrategySpec): ExitName[] {
  const out: ExitName[] = [];
  if (spec.risk.stopDistanceBps.inferred) out.push('stop_distance');
  const target = spec.risk.targetDistanceBps;
  if (!target || target.inferred) out.push('target_distance');
  return out;
}

export function exitsStated(spec: StrategySpec): boolean {
  return missingExits(spec).length === 0;
}

function missingWords(missing: readonly ExitName[]): string {
  const stop = missing.includes('stop_distance');
  const target = missing.includes('target_distance');
  return stop && target ? 'stop or target' : stop ? 'stop' : 'target';
}

/**
 * Why a rule cannot be pinned, amended or tested yet, as one sentence the pin,
 * review and test screens show as it is. Empty when nothing is missing.
 */
export function exitsSentence(missing: readonly ExitName[]): string {
  if (missing.length === 0) return '';
  return `This rule has no stated ${missingWords(missing)}. A rule is pinned and tested only with a stop and a target you set.`;
}

/**
 * The compiler's reply when the user has not said where they get out. It asks
 * for distances from entry, because that is the only form an exit takes in the
 * spec; a price level is not one.
 */
export function exitsQuestion(missing: readonly ExitName[]): string {
  const stop = missing.includes('stop_distance');
  const target = missing.includes('target_distance');
  if (stop && target) {
    return (
      'Where are your stop and your target? Give each as a distance from entry, for example a 2% stop ' +
      'and a 4% target. The target can also be a multiple of the stop, such as 2R. Nothing compiles until you set both.'
    );
  }
  if (stop) {
    return 'Where is your stop? Give it as a distance from entry, for example 2%. Nothing compiles until you set it.';
  }
  return (
    'Where is your target? Give it as a distance from entry, for example 4%, or as a multiple of ' +
    'your stop, such as 2R. Nothing compiles until you set it.'
  );
}
