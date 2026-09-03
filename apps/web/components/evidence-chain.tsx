'use client';

import { useState } from 'react';
import { Num } from '@/components/ui';
import { cx } from '@/lib/cx';

export interface Claim {
  readonly symbol: string;
  readonly summary: string;
  readonly fields: readonly (readonly [string, string])[];
}

/**
 * Evidence is reachable in one tap from any claim the product displays. Each
 * row expands to the attested price, the threshold it was compared against, the
 * timestamp, the oracle and the signature — everything the contract's
 * arithmetic actually ran on.
 */
export function EvidenceChain({ claims }: { claims: readonly Claim[] }) {
  const [open, setOpen] = useState(0);

  return (
    <div className="mt-3 border border-hairline bg-panel">
      {claims.map((claim, i) => {
        const expanded = open === i;
        return (
          <div
            key={claim.symbol}
            className={cx(i < claims.length - 1 && 'border-b border-hairline')}
          >
            <button
              type="button"
              onClick={() => setOpen(expanded ? -1 : i)}
              aria-expanded={expanded}
              className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-3.25 text-left"
            >
              <div className="flex flex-col gap-1.75">
                <span className="font-mono text-12 font-medium">{claim.symbol}</span>
                {expanded ? null : (
                  <Num className="text-11 text-ash">{claim.summary}</Num>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="font-mono text-10 tracking-w10 text-long">SIGNED</span>
                <span className="font-mono text-11 text-ash" aria-hidden>
                  {expanded ? '▾' : '▸'}
                </span>
              </div>
            </button>
            {expanded ? (
              <div className="flex flex-col gap-2 px-3.5 pb-3.25 font-mono text-11p5 text-ash">
                {claim.fields.map(([name, value]) => (
                  <div key={name} className="flex justify-between gap-3">
                    <span>{name}</span>
                    <Num className="text-bone">{value}</Num>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
