import { OnboardingScreen } from '@/components/onboarding';
import { GhostButton, Num } from '@/components/ui';
import { ONBOARDING } from '@/lib/demo';
import { cx } from '@/lib/cx';

/**
 * 10B · ONBOARDING · FUND.
 *
 * Paper mode is offered as a first-class option, not a demo mode: the rule is
 * enforced either way, and enforcement is what the product is.
 */
export default function OnboardingFundPage() {
  return (
    <OnboardingScreen
      step={2}
      label="10B · ONBOARDING · FUND"
      title="Give the rule something to enforce."
      blurb="Connect an exchange account or fund the Kanon wallet directly. You can change this later."
      footer={
        <GhostButton href="/onboarding/strategy">SKIP FOR NOW</GhostButton>
      }
    >
      <div className="mt-8.5 flex flex-col">
        {ONBOARDING.fund.map((option, i) => (
          <button
            key={option.title}
            type="button"
            className={cx(
              'flex cursor-pointer items-center justify-between gap-3 border-t border-hairline py-4.25 text-left',
              i === ONBOARDING.fund.length - 1 && 'border-b',
            )}
          >
            <div className="flex flex-col gap-1.75">
              <span
                className={cx(
                  'font-mono text-13 font-medium',
                  option.muted && 'text-ash',
                )}
              >
                {option.title}
              </span>
              <Num className="text-10p5 text-ash">{option.sub}</Num>
            </div>
            <span className="font-mono text-12 text-ash" aria-hidden>
              →
            </span>
          </button>
        ))}
      </div>
    </OnboardingScreen>
  );
}
