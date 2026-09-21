import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { formatDecimal, type Decimal } from '@kanon/spec';
import { BottomSheet } from './bottom-sheet';
import { Dot, Meta, Num, PrimaryButton } from './ui';
import { cx } from '../lib/cx';
import { formatMoney, parseAmount } from '../lib/vault-map';
import type { VaultOutcome } from '../lib/vault-types';

/** A toggle or a preset. Selected is `signal`, and says so with a mark, not colour alone. */
export function Chip({
  label,
  selected,
  onPress,
  className,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  className?: string | undefined;
}) {
  return (
    <Pressable
      role="checkbox"
      aria-checked={selected}
      onPress={onPress}
      className={cx(
        'flex-row items-center gap-1.5 rounded-[2px] border px-2.5 py-2.25',
        selected ? 'border-signal bg-diff-wash' : 'border-hairline bg-panel',
        className,
      )}
    >
      <Text className={cx('font-mono text-10 tracking-w08', selected ? 'text-signal' : 'text-ash')}>
        {selected ? '✓' : '+'}
      </Text>
      <Text className={cx('font-mono text-11 tracking-w06', selected ? 'text-bone' : 'text-ash')}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled text field. Monospaced, because everything typed here is a number or an address. */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  keyboardType,
  invalid,
  suffix,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string | undefined;
  hint?: string | undefined;
  keyboardType?: 'default' | 'decimal-pad' | undefined;
  invalid?: boolean | undefined;
  suffix?: string | undefined;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View className="gap-2">
      <Meta className="tracking-w16">{label}</Meta>
      <View
        className={cx(
          'flex-row items-center border bg-panel px-3',
          invalid ? 'border-signal' : focused ? 'border-verified' : 'border-hairline',
        )}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          {...(placeholder ? { placeholder } : {})}
          placeholderTextColor={colors.ash}
          cursorColor={colors.signal}
          selectionColor={colors.signal}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize="none"
          autoCorrect={false}
          aria-label={label}
          className="min-w-0 flex-1 py-3 font-mono text-13 text-bone"
          style={{ fontVariant: ['tabular-nums'] }}
        />
        {suffix ? <Text className="pl-2 font-mono text-11 tracking-w10 text-ash">{suffix}</Text> : null}
      </View>
      {hint ? <Text className="font-mono text-10 text-ash leading-[1.5]">{hint}</Text> : null}
    </View>
  );
}

/**
 * The result of an action, in words. A refusal from the chain or a declined
 * signature is `ash` with a hollow mark, never `refused`: nothing went wrong
 * that the person needs to be alarmed by, and nothing was sent.
 */
export function Notice({ outcome }: { outcome: VaultOutcome | null }) {
  if (!outcome) return null;
  return (
    <View className="mt-4 flex-row gap-2.5 border border-hairline bg-panel px-3.5 py-3" role="status">
      <Dot className={cx('mt-1.25', outcome.ok ? 'bg-signal' : 'border border-ash')} />
      <Text className="flex-1 font-mono text-11p5 text-bone leading-[1.5]">{outcome.message}</Text>
    </View>
  );
}

/** A standing message: not deployed, no wallet, demo. Honest about what cannot happen. */
export function AvailabilityNote({ state, message }: { state: string; message?: string | undefined }) {
  if (state === 'ready') return null;
  const label = state === 'not_deployed' ? 'NOT DEPLOYED' : state === 'no_wallet' ? 'NO WALLET' : 'DEMO DATA';
  return (
    <View className="mt-5 gap-2 border border-inferred-edge bg-inferred-wash px-3.5 py-3">
      <Text className="font-mono text-9 tracking-w18 text-signal">{label}</Text>
      {message ? <Text className="font-sans text-13 text-bone leading-[1.5]">{message}</Text> : null}
    </View>
  );
}

/**
 * Deposit or withdraw, in a bottom sheet. The amount is typed as a decimal and
 * parsed to integer atoms from the string, never through a float; more digits
 * than the token has is refused rather than rounded.
 */
export function AmountSheet({
  open,
  onClose,
  title,
  action,
  decimals,
  symbol,
  available,
  availableLabel,
  onSubmit,
  note,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  action: string;
  decimals: number;
  symbol: string;
  /** The most that can move, in atoms. Null when it has not been read. */
  available: Decimal | null;
  availableLabel: string;
  onSubmit: (amount: Decimal) => Promise<VaultOutcome>;
  note?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VaultOutcome | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setResult(null);
      setBusy(false);
    }
  }, [open]);

  const parsed = text === '' ? null : parseAmount(text, decimals);
  const over =
    parsed?.ok && available !== null ? parsed.atoms > BigInt(available.atoms) : false;
  const problem = parsed && !parsed.ok ? parsed.error : over ? 'That is more than is available.' : null;

  async function submit() {
    if (!parsed?.ok || busy || over) return;
    setBusy(true);
    const outcome = await onSubmit({ atoms: parsed.atoms.toString(), decimals });
    setBusy(false);
    setResult(outcome);
    if (outcome.ok) setText('');
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={title} meta={symbol}>
      <View className="gap-4 pb-2">
        {available ? (
          <View className="flex-row items-baseline justify-between">
            <Meta>{availableLabel}</Meta>
            <Pressable
              role="button"
              onPress={() => setText(formatDecimal(available, { group: false }))}
              aria-label={`Use the full ${availableLabel.toLowerCase()}`}
            >
              <Num className="text-13 text-bone">
                {formatMoney(available)} <Text className="text-10 tracking-w12 text-verified">MAX</Text>
              </Num>
            </Pressable>
          </View>
        ) : null}
        <Field
          label="AMOUNT"
          value={text}
          onChangeText={setText}
          placeholder="0.00"
          keyboardType="decimal-pad"
          invalid={Boolean(problem)}
          suffix={symbol}
          hint={problem ?? undefined}
        />
        {note}
        <Notice outcome={result} />
        <PrimaryButton disabled={!parsed?.ok || over || busy} onPress={() => void submit()}>
          {busy ? 'WAITING FOR SIGNATURE' : action}
        </PrimaryButton>
      </View>
    </BottomSheet>
  );
}
