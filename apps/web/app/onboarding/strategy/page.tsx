'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { OnboardingScreen } from '@/components/onboarding';
import { Num, PrimaryButton } from '@/components/ui';
import { ONBOARDING } from '@/lib/demo';

const LIMIT = 400;

/**
 * 10C · ONBOARDING · FIRST STRATEGY.
 *
 * Onboarding ends in a text field, on purpose. The first thing the product asks
 * for is the rule you keep breaking, in your own words — the compiler's job is
 * to translate it, not to improve it.
 */
export default function OnboardingStrategyPage() {
  const router = useRouter();
  const [text, setText] = useState('');

  return (
    <OnboardingScreen
      step={3}
      label="10C · ONBOARDING · FIRST STRATEGY"
      title="Describe the rule you keep breaking."
      blurb="Write it the way you'd say it out loud. Kanon compiles it into something a contract can check."
      footer={
        <PrimaryButton onClick={() => router.push('/compile')}>COMPILE</PrimaryButton>
      }
    >
      <div className="mt-7.5 flex min-h-29.5 flex-col justify-between gap-3 border border-hairline bg-panel p-3.75 focus-within:border-signal">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, LIMIT))}
          rows={3}
          placeholder="Only take longs after a sweep of the previous day's low"
          aria-label="Your rule, in plain English"
          className="resize-none bg-transparent font-mono text-13p5 leading-[1.55] text-bone caret-signal outline-none placeholder:text-ash"
        />
        <div className="flex items-center justify-between">
          <span className="font-mono text-9 tracking-w16 text-ash">PLAIN ENGLISH</span>
          <Num className="text-9 tracking-w16 text-ash">
            {text.length} / {LIMIT}
          </Num>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2.5">
        <span className="font-mono text-9 tracking-w20 text-ash">OR START FROM</span>
        <div className="flex flex-wrap gap-2">
          {ONBOARDING.starters.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => setText(starter)}
              className="cursor-pointer rounded-[2px] border border-hairline px-2.5 py-2 font-mono text-11 text-ash hover:border-signal hover:text-signal"
            >
              {starter}
            </button>
          ))}
        </div>
      </div>
    </OnboardingScreen>
  );
}
