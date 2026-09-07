import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Num } from './ui';
import { cx } from '../lib/cx';

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
    <View className="mt-3 border border-hairline bg-panel">
      {claims.map((claim, i) => {
        const expanded = open === i;
        return (
          <View
            key={claim.symbol}
            className={cx(i < claims.length - 1 && 'border-b border-hairline')}
          >
            <Pressable
              onPress={() => setOpen(expanded ? -1 : i)}
              role="button"
              aria-expanded={expanded}
              className="w-full flex-row items-center justify-between gap-3 px-3.5 py-3.25"
            >
              <View className="gap-1.75">
                <Text className="font-mono-medium text-12 text-bone">{claim.symbol}</Text>
                {expanded ? null : (
                  <Num className="text-11 text-ash">{claim.summary}</Num>
                )}
              </View>
              <View className="shrink-0 flex-row items-center gap-2.5">
                <Text className="font-mono text-10 tracking-w10 text-long">SIGNED</Text>
                <Text className="font-mono text-11 text-ash" aria-hidden>
                  {expanded ? '▾' : '▸'}
                </Text>
              </View>
            </Pressable>
            {expanded ? (
              <View className="gap-2 px-3.5 pb-3.25">
                {claim.fields.map(([name, value]) => (
                  <View key={name} className="flex-row justify-between gap-3">
                    <Text className="font-mono text-11p5 text-ash">{name}</Text>
                    <Num className="text-11p5 text-bone">{value}</Num>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
