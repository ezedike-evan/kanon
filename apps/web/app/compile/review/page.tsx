'use client';

import { Fragment, useState } from 'react';
import { Body, Footer, NavBar, Screen } from '@/components/chrome';
import { Dot, Num, PrimaryButton } from '@/components/ui';
import { REVIEW } from '@/lib/demo';
import { cx } from '@/lib/cx';

type View = 'plain' | 'parametric';

/**
 * 03 · SPEC REVIEW.
 *
 * Compilation is always reviewed, never silent. Two registers: plain English by
 * default, parametric one toggle away. Every default the compiler chose is
 * listed by name — a user who discovers an unseen parameter later is a
 * permanent loss of trust, so there is nowhere for one to hide.
 */
export default function SpecReviewPage() {
  const [view, setView] = useState<View>('plain');

  return (
    <Screen label="03 · SPEC REVIEW">
      <NavBar left="REVIEW SPEC" right="CLOSE ✕" />

      <div className="mx-5 mt-5 flex shrink-0 overflow-hidden rounded-[2px] border border-hairline">
        {(['plain', 'parametric'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            aria-pressed={view === key}
            className={cx(
              'flex-1 cursor-pointer py-2.75 text-center font-mono text-11 tracking-w12 transition-colors',
              view === key ? 'bg-raised text-bone' : 'text-ash hover:text-bone',
            )}
          >
            {key === 'plain' ? 'PLAIN ENGLISH' : 'PARAMETRIC'}
          </button>
        ))}
      </div>

      <Body className="pt-6.5">
        {view === 'plain' ? (
          <div className="flex flex-col gap-5.5">
            {REVIEW.plain.map((segments, i) => (
              <Fragment key={i}>
                {i > 0 ? <div className="h-px bg-hairline" /> : null}
                <div className="flex flex-col gap-2.5">
                  <span className="font-mono text-9 tracking-w20 text-ash">
                    PREDICATE {String(i + 1).padStart(2, '0')}
                  </span>
                  <p className="text-15 leading-[1.6] text-pretty">
                    {segments.map((segment, j) =>
                      typeof segment === 'string' ? (
                        <span key={j}>{segment}</span>
                      ) : (
                        /* Bound parameters are editable in place. No hidden defaults. */
                        <button
                          key={j}
                          type="button"
                          className="cursor-pointer border-b border-signal pb-px font-mono text-13 tabular-nums text-signal"
                        >
                          {segment.param}
                        </button>
                      ),
                    )}
                  </p>
                </div>
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="flex flex-col font-mono text-12 leading-[1.85] text-ash">
            {REVIEW.parametric.map((line, i) => (
              <div key={line} className="flex gap-3">
                <Num className="w-4 text-hairline">
                  {String(i + 1).padStart(2, '0')}
                </Num>
                <span>{line}</span>
              </div>
            ))}
          </div>
        )}

        {/* Surfaced in both registers: an inferred default is never silent. */}
        <div className="mt-5 mb-5 border border-inferred-edge bg-inferred-wash p-3.5">
          <div className="flex items-center gap-2.25">
            <Dot className="bg-signal" />
            <span className="font-mono text-9 tracking-w18 text-signal">
              <Num>{REVIEW.inferred.length}</Num> DEFAULTS INFERRED
            </span>
          </div>
          <div className="mt-2.75 flex flex-col gap-1.75 font-mono text-11p5 leading-[1.5] text-ash">
            {REVIEW.inferred.map((d) => (
              <div key={d.name} className="flex justify-between gap-3">
                <span>{d.name}</span>
                <span>
                  <Num className="text-bone">{d.value}</Num>
                  <span className="ml-3">— not stated</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Body>

      <Footer className="border-t border-hairline pt-5">
        <div className="mb-4 flex items-center justify-between font-mono text-10 tracking-w10 text-ash">
          <span>ENFORCEMENT</span>
          <span className="text-bone">IMMEDIATE ON PIN</span>
        </div>
        <PrimaryButton href="/compile/pin">PIN ON-CHAIN</PrimaryButton>
      </Footer>
    </Screen>
  );
}
