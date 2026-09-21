import { useRef, useState } from 'react';
import { Text, TextInput, View, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native';
import { canSend, charCount, clampText, composerHeight, MESSAGE_LIMIT } from '../../lib/ai-chat';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import { isWeb } from '../../platform';
import { useTheme } from '../../theme';
import { IconButton } from '../icon-button';
import { Num } from '../ui';

const LINE = 22;

/**
 * The message box. Multiline, grows to about five lines and then scrolls, capped
 * at `MESSAGE_LIMIT` by characters as a person counts them. On the web Enter
 * sends and Shift+Enter breaks a line; on a phone Return breaks a line and the
 * button sends, because a thumb keyboard has no Shift.
 *
 * It stays editable while a compile runs, so the next thought can be written;
 * only the send button waits.
 */
export function Composer({
  value,
  onChange,
  onSend,
  compiling,
  placeholder,
  onFocusChange,
  inputRef,
  footer,
  bottomPad,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  compiling: boolean;
  placeholder: string;
  onFocusChange?: ((focused: boolean) => void) | undefined;
  inputRef?: React.RefObject<TextInput | null> | undefined;
  /** Sits under the box: the hint row. */
  footer?: React.ReactNode;
  bottomPad: number;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState(composerHeight(1));
  const enabled = canSend({ text: value, compiling });
  const near = charCount(value) >= MESSAGE_LIMIT * 0.85;
  const sizing = useRef(0);

  function grow(e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) {
    // Content height is the text plus the 8px of padding above and below it.
    const lines = Math.max(1, Math.round((e.nativeEvent.contentSize.height - 16) / LINE));
    if (sizing.current !== lines) {
      sizing.current = lines;
      setHeight(composerHeight(lines, { line: LINE }));
    }
  }

  return (
    <View className="shrink-0 border-t border-hairline bg-void px-4 pt-3" style={{ paddingBottom: bottomPad }}>
      {/* From `lg` the box keeps the thread's readable width (720 less its gutters) and sits centred under it. */}
      <View className={cx('w-full self-center', web('lg:max-w-[680px]'))}>
        <View
          className={cx(
            'flex-row items-end gap-2 rounded-sm border bg-panel py-1 pl-3.5 pr-1',
            focused ? 'border-signal' : 'border-hairline',
          )}
        >
          <TextInput
            ref={inputRef}
            value={value}
            onChangeText={(next) => onChange(clampText(next))}
            onFocus={() => {
              setFocused(true);
              onFocusChange?.(true);
            }}
            onBlur={() => {
              setFocused(false);
              onFocusChange?.(false);
            }}
            onContentSizeChange={grow}
            onKeyPress={
              isWeb
                ? (e) => {
                    const ev = e.nativeEvent as { key?: string; shiftKey?: boolean };
                    if (ev.key === 'Enter' && !ev.shiftKey) {
                      (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                      onSend();
                    }
                  }
                : undefined
            }
            multiline
            blurOnSubmit={false}
            placeholder={placeholder}
            placeholderTextColor={colors.ash}
            cursorColor={colors.signal}
            selectionColor={colors.signal}
            aria-label="Message to the strategy AI"
            className="min-w-0 flex-1 py-2 font-sans text-15 text-bone"
            style={{ height, lineHeight: LINE, textAlignVertical: 'top', outlineStyle: 'none' } as never}
          />
          <IconButton
            icon="arrow-up"
            variant="solid"
            size="lg"
            label={compiling ? 'Compiling, send is unavailable' : 'Send message'}
            disabled={!enabled}
            onPress={onSend}
          />
        </View>
        <View className="min-h-6 flex-row items-center justify-between px-0.5 pt-1.5">
          <View className="min-w-0 flex-1">{footer}</View>
          {value.length > 0 ? (
            <Num className={cx('text-10', near ? 'text-signal' : 'text-ash')}>
              {charCount(value)} / {MESSAGE_LIMIT}
            </Num>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** The one-line hint under the box. Sentence case, ash, never a warning. */
export function ComposerHint({ children }: { children: React.ReactNode }) {
  return <Text className="font-sans text-11 text-ash">{children}</Text>;
}
