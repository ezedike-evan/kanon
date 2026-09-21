import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { bpsToPercentText, parsePercentToBps, type EditableParam } from '@kanon/spec';
import { useTheme } from '../theme';
import { Num, PrimaryButton } from './ui';
import { cx } from '../lib/cx';
import type { EditOutcome } from '../lib/flow-types';

/**
 * A bound parameter, edited in a bottom sheet (not a modal): the sheet rises
 * from the thumb, the spec stays in view behind it, and the change lands in the
 * spec the moment it is accepted.
 *
 * An enum is a list of the only values it may take. A number is a text box with
 * its bounds written under it. A percentage is typed as a percentage and parsed
 * to integer basis points from the string, never through a float.
 */
export function ParamSheet({
  param,
  onClose,
  onSubmit,
}: {
  param: EditableParam | null;
  onClose: () => void;
  onSubmit: (value: string | number) => EditOutcome;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!param) return;
    setError(null);
    setText(
      param.kind === 'int'
        ? param.unit === 'bps'
          ? bpsToPercentText(Number(param.value))
          : String(param.value)
        : '',
    );
  }, [param?.key, param?.value]);

  if (!param) return null;

  function apply(value: string | number) {
    const result = onSubmit(value);
    if (result.ok) onClose();
    else setError(result.error);
  }

  function submitNumber() {
    if (!param) return;
    if (param.unit === 'bps') {
      const bps = parsePercentToBps(text);
      if (bps === null) {
        setError('Enter a percentage with at most two decimals, for example 0.15.');
        return;
      }
      apply(bps);
      return;
    }
    if (!/^\d+$/.test(text.trim())) {
      setError('Enter a whole number.');
      return;
    }
    apply(Number(text.trim()));
  }

  const bounds =
    param.kind === 'int' && param.min !== undefined && param.max !== undefined
      ? param.unit === 'bps'
        ? `${bpsToPercentText(param.min)} to ${bpsToPercentText(param.max)} percent`
        : `${param.min} to ${param.max} ${param.unit ?? ''}`.trim()
      : null;

  return (
    <View className="absolute inset-0 justify-end" pointerEvents="box-none">
      <Pressable
        onPress={onClose}
        aria-label="Close the editor"
        className="absolute inset-0 bg-void opacity-70"
      />
      <View className="border-t border-hairline bg-raised px-5 pt-4 pb-8" role="dialog" aria-label={`Edit ${param.name}`}>
        <View className="flex-row items-center justify-between">
          <Text className="font-mono text-9 tracking-w20 text-ash">{param.name.toUpperCase()}</Text>
          <Pressable onPress={onClose} role="button" aria-label="Close">
            <Text className="font-mono text-10 tracking-w12 text-ash">CLOSE ✕</Text>
          </Pressable>
        </View>

        <View className="mt-3 flex-row items-baseline justify-between">
          <Num className="font-mono-medium text-18 text-signal">{param.display}</Num>
          {param.inferred ? (
            <Text className="font-mono text-10 tracking-w10 text-signal">INFERRED · NOT STATED</Text>
          ) : (
            <Text className="font-mono text-10 tracking-w10 text-ash">STATED</Text>
          )}
        </View>

        {param.kind === 'enum' ? (
          <View className="mt-3 border-t border-hairline">
            {(param.options ?? []).map((option) => {
              const selected = option === String(param.value);
              return (
                <Pressable
                  key={option}
                  onPress={() => apply(option)}
                  role="button"
                  aria-pressed={selected}
                  className="flex-row items-center justify-between border-b border-hairline py-3.5"
                >
                  <Num className={cx('text-13', selected ? 'text-signal' : 'text-bone')}>{option}</Num>
                  <Text className="font-mono text-11 text-signal" aria-hidden>
                    {selected ? '●' : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View className="mt-3 gap-3">
            <View className="flex-row items-center gap-3 border border-hairline bg-panel px-3.5 py-3">
              <TextInput
                value={text}
                onChangeText={(next) => {
                  setText(next);
                  setError(null);
                }}
                keyboardType={param.unit === 'bps' ? 'decimal-pad' : 'number-pad'}
                autoFocus
                onSubmitEditing={submitNumber}
                aria-label={param.name}
                placeholderTextColor={colors.ash}
                cursorColor={colors.signal}
                selectionColor={colors.signal}
                className="flex-1 font-mono text-15 text-bone"
                style={{ fontVariant: ['tabular-nums'] }}
              />
              <Text className="font-mono text-11 text-ash">
                {param.unit === 'bps' ? '%' : (param.unit ?? '')}
              </Text>
            </View>
            {bounds ? <Text className="font-mono text-10 text-ash">{bounds}</Text> : null}
            <PrimaryButton onPress={submitNumber} className="py-4">
              APPLY
            </PrimaryButton>
          </View>
        )}

        {error ? <Text className="mt-3 font-mono text-11 text-signal leading-[1.5]">{error}</Text> : null}
      </View>
    </View>
  );
}
