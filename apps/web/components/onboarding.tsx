import type { ReactNode } from 'react';
import { Screen } from '@/components/chrome';

/**
 * Three onboarding screens, one shape: a headline that arrives low on the
 * screen, a sentence under it, the choice, and a bottom-anchored action.
 * Everything is reachable with one thumb.
 */
export function OnboardingScreen({
  step,
  label,
  title,
  blurb,
  children,
  footer,
}: {
  step: 1 | 2 | 3;
  label: string;
  title: string;
  blurb: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Screen label={label}>
      <div className="flex shrink-0 items-center justify-between px-5 pt-5.5">
        <span className="font-mono text-12 font-bold tracking-w22">KANON</span>
        <span className="font-mono text-10 tracking-w14 tabular-nums text-ash">
          {String(step).padStart(2, '0')} / 03
        </span>
      </div>

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-5 pb-2.5">
        <h1 className="text-32 leading-[1.1] font-medium tracking-t25 text-pretty">
          {title}
        </h1>
        <p className="mt-4.5 text-15 leading-[1.55] text-ash text-pretty">{blurb}</p>
        {children}
      </div>

      <div className="shrink-0 px-5 pt-6 pb-8.5">{footer}</div>
    </Screen>
  );
}
