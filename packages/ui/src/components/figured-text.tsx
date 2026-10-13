import { useMemo } from 'react';
import { Text } from 'react-native';
import { splitFigures } from '../lib/figures';

/**
 * A sentence with its figures set monospaced and tabular, and the words around
 * them left in the face `className` gives the line. For prose that states a
 * number (`within 2 minutes`, `$10 for 15m`): the rule that every number is
 * monospaced has no exception for a sentence.
 */
export function FiguredText({
  text,
  className,
  numberOfLines,
}: {
  text: string;
  className?: string | undefined;
  numberOfLines?: number | undefined;
}) {
  const parts = useMemo(() => splitFigures(text), [text]);
  return (
    <Text {...(className ? { className } : {})} {...(numberOfLines !== undefined ? { numberOfLines } : {})}>
      {parts.map((part, i) =>
        part.mono ? (
          <Text key={i} className="font-mono" style={{ fontVariant: ['tabular-nums'] }}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
