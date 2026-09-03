import { OnboardingScreen } from '@/components/onboarding';
import { PrimaryButton } from '@/components/ui';

/**
 * 10A · ONBOARDING · PASSKEY.
 *
 * A passkey, not a seed phrase. Kanon never holds a key and cannot move funds —
 * stated here because it is the first thing this audience will want to know.
 */
export default function OnboardingPasskeyPage() {
  return (
    <OnboardingScreen
      step={1}
      label="10A · ONBOARDING · PASSKEY"
      title="Sign in with your face. No seed phrase."
      blurb="Your account is a passkey held by this device. Kanon never sees a key and cannot move your funds."
      footer={<PrimaryButton href="/onboarding/fund">CONTINUE</PrimaryButton>}
    >
      <div className="mt-8.5 flex items-center gap-3.5 border-y border-hairline py-4.5">
        <div className="flex size-9.5 shrink-0 items-center justify-center rounded-full border border-signal">
          <div className="size-3 rounded-full border border-signal" />
        </div>
        <div className="flex flex-col gap-1.25">
          <span className="font-mono text-11 tracking-w10">FACE ID</span>
          <span className="font-mono text-10 text-ash">
            Creates your passkey on this device
          </span>
        </div>
      </div>
    </OnboardingScreen>
  );
}
