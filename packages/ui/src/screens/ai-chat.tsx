import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AiTile } from '../components/ai/ai-tile';
import { Composer, ComposerHint } from '../components/ai/composer';
import { DraftDock } from '../components/ai/draft-dock';
import { ChatMessage } from '../components/ai/message';
import { TypingIndicator } from '../components/ai/typing';
import { Welcome } from '../components/ai/welcome';
import { BottomSheet } from '../components/bottom-sheet';
import { Screen, StatusBar, TabBar } from '../components/chrome';
import { Divider } from '../components/divider';
import { IconButton } from '../components/icon-button';
import { Icon, type Icon as IconName } from '../components/icons';
import { Enter } from '../components/motion';
import { SectionHeader } from '../components/section-header';
import { Skeleton } from '../components/skeleton';
import { GhostButton, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { isIOS, isWeb } from '../platform';
import {
  buildThread,
  classifyFailure,
  clampText,
  draftLines,
  isNearBottom,
  lastUserText,
  pickSuggestions,
  sendIntent,
  type ThreadItem,
} from '../lib/ai-chat';
import { cx } from '../lib/cx';
import { useKanonSelector } from '../lib/data';
import { routes } from '../lib/routes';
import { useKeyboardVisible, useReducedMotion } from '../lib/use-keyboard';

/**
 * The AI tab: a conversation with the strategy model.
 *
 * You say a rule; the model translates it into a spec; the spec forms in a dock
 * under the thread. That is the whole loop, and the screen says so in its first
 * sentence. Three product rules are load-bearing here and none of them is
 * decoration:
 *
 * - The AI proposes and never pins. Nothing in this screen writes a rule to the
 *   chain; the only way onward is the review, and the user takes it.
 * - No hidden parameters. Every value the model chose for itself is listed in the
 *   dock and marked DEFAULT.
 * - A compile that did not land is neutral. It says what happened and keeps the
 *   user's words; it is not styled as an alarm.
 *
 * Mounted at both `/create` (the tab) and `/compile` (where onboarding lands).
 */
export function AiChatScreen() {
  const nav = useNavigator();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const keyboard = useKeyboardVisible();

  const compiler = useKanonSelector((s) => s.compiler);
  const review = useKanonSelector((s) => s.review);
  const session = useKanonSelector((s) => s.session);
  const mode = useKanonSelector((s) => s.mode);
  const starters = useKanonSelector((s) => s.onboardingStrategy.starters);
  const send = useKanonSelector((s) => s.sendCompilerMessage);

  const signedIn = mode === 'live' && session.signedIn;
  const sample = !signedIn;
  const compiling = compiler.status === 'compiling';
  const failed = compiler.status === 'failed';
  const loading = session.pending && compiler.transcript.length === 0;

  const [text, setText] = useState('');
  const [dockOpen, setDockOpen] = useState(false);
  const [sheet, setSheet] = useState<'signin' | 'how' | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const listRef = useRef<FlatList<ThreadItem> | null>(null);
  const stick = useRef(true);
  const laidOut = useRef(false);
  const lastContent = useRef(0);

  const thread = useMemo(
    () => buildThread({ transcript: compiler.transcript, sample, hasSpec: compiler.hasSpec }),
    [compiler.transcript, sample, compiler.hasSpec],
  );
  // Turns that were already here when the screen opened do not animate in; later ones do.
  const firstKeys = useRef<Set<string> | null>(null);
  if (firstKeys.current === null) firstKeys.current = new Set(thread.map((i) => i.key));

  const lines = useMemo(() => draftLines(compiler.lines, review.inferred), [compiler.lines, review.inferred]);
  const suggestions = useMemo(
    () =>
      pickSuggestions({
        starters,
        sent: compiler.transcript.filter((t) => t.from === 'YOU').map((t) => t.text),
        hasSpec: compiler.hasSpec,
        count: compiler.transcript.length === 0 ? 4 : 3,
      }),
    [starters, compiler.transcript, compiler.hasSpec],
  );

  const submit = useCallback(() => {
    const intent = sendIntent({ text, compiling, signedIn });
    if (intent === 'ignore') return;
    if (intent === 'sign_in') {
      setSheet('signin');
      return;
    }
    const message = text.trim();
    setText('');
    stick.current = true;
    void send(message);
  }, [text, compiling, signedIn, send]);

  const retry = useCallback(() => {
    const again = lastUserText(compiler.transcript);
    if (!again) return;
    stick.current = true;
    void send(again);
  }, [compiler.transcript, send]);

  const pick = useCallback((prompt: string) => {
    setText(clampText(prompt));
    inputRef.current?.focus();
  }, []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    // New content below is not the reader leaving; only a scroll away with the content unchanged is.
    const grew = contentSize.height > lastContent.current;
    lastContent.current = contentSize.height;
    if (grew && stick.current) return;
    stick.current = isNearBottom({
      offset: contentOffset.y,
      viewport: layoutMeasurement.height,
      content: contentSize.height,
    });
  }, []);

  const followEnd = useCallback(() => {
    if (!stick.current) return;
    // The first paint jumps; later growth glides, unless motion is reduced.
    listRef.current?.scrollToEnd({ animated: laidOut.current && !reduced });
    laidOut.current = true;
  }, [reduced]);

  const renderItem = useCallback(
    ({ item }: { item: ThreadItem }) =>
      item.kind === 'sample' ? (
        <View className="items-center gap-2 pb-1">
          <Divider label="Sample conversation" className="self-stretch" />
          <Text className="text-center font-sans text-12 leading-[18px] text-ash">
            Not yours yet. Sign in to compile your own rule.
          </Text>
        </View>
      ) : (
        <ChatMessage
          item={item}
          lines={lines}
          onOpenDraft={() => setDockOpen(true)}
          animate={!firstKeys.current?.has(item.key)}
        />
      ),
    [lines],
  );

  const footer = (
    <View className="gap-4 pt-4">
      {compiling ? <TypingIndicator /> : null}
      {failed ? <FailureNote error={compiler.error} canRetry={lastUserText(compiler.transcript) !== null} onRetry={retry} /> : null}
      {!compiling && !failed && compiler.transcript.length > 0 && suggestions.length > 0 ? (
        <QuickReplies suggestions={suggestions} onPick={pick} />
      ) : null}
    </View>
  );

  return (
    <Screen label="STRATEGY AI">
      <StatusBar />
      <KeyboardAvoidingView
        behavior={isIOS ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 3}
        style={{ flex: 1, minHeight: 0 }}
      >
        <View className="shrink-0 flex-row items-center gap-3 border-b border-hairline px-5 pb-3 pt-4">
          <AiTile size="md" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text role="heading" className="font-sans text-18 font-medium leading-6 text-bone">
              Strategy AI
            </Text>
            <Text className="font-sans text-12 leading-[17px] text-ash">Language model · never trades or pins</Text>
          </View>
          <IconButton icon="info" label="How the strategy AI works" variant="outline" size="sm" onPress={() => setSheet('how')} />
        </View>

        {loading ? (
          <ThreadSkeleton />
        ) : (
          <FlatList
            ref={listRef}
            style={{ flex: 1, minHeight: 0 }}
            data={thread}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            ItemSeparatorComponent={Gap}
            ListEmptyComponent={<Welcome suggestions={suggestions} onPick={pick} />}
            ListFooterComponent={footer}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, flexGrow: 1 }}
            onScroll={onScroll}
            scrollEventThrottle={64}
            onContentSizeChange={followEnd}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={isIOS ? 'interactive' : 'on-drag'}
            showsVerticalScrollIndicator={false}
            initialNumToRender={14}
            maxToRenderPerBatch={10}
            windowSize={9}
            removeClippedSubviews={!isWeb}
          />
        )}

        {compiler.hasSpec ? (
          <DraftDock
            lines={lines}
            plain={review.plain}
            label={compiler.draft}
            expanded={dockOpen}
            onToggle={() => setDockOpen((v) => !v)}
            onReview={() => nav.push(routes.compileReview)}
            compiling={compiling}
            sample={sample}
          />
        ) : null}

        <Composer
          value={text}
          onChange={setText}
          onSend={submit}
          compiling={compiling}
          placeholder={compiler.hasSpec ? 'Change a value or add a condition' : 'Describe the rule you keep breaking'}
          onFocusChange={(focused) => {
            if (focused) {
              setDockOpen(false);
              stick.current = true;
            }
          }}
          inputRef={inputRef}
          // The raised AI tab button rises 18px into the strip above the bar; the hint clears it.
          bottomPad={keyboard ? 10 : 22}
          footer={
            <ComposerHint>
              {isWeb ? 'Enter to send · Shift+Enter for a new line' : 'The AI proposes. You review and pin.'}
            </ComposerHint>
          }
        />

        {keyboard ? null : <TabBar active="create" />}
      </KeyboardAvoidingView>

      <BottomSheet
        open={sheet === 'signin'}
        onClose={() => setSheet(null)}
        title="SIGN IN"
        meta="SAMPLE CONVERSATION"
      >
        <View className="gap-4 pb-2">
          <View className="gap-2">
            <Text className="font-sans text-18 font-medium leading-6 text-bone">Compile your own rule</Text>
            <Text className="font-sans text-14 leading-[21px] text-ash">
              What you see here is a sample. Compiling runs a language model on your account, so it needs you signed
              in. Your message stays in the box.
            </Text>
          </View>
          <View className="gap-2">
            <PrimaryButton
              onPress={() => {
                setSheet(null);
                nav.push(routes.onboarding);
              }}
            >
              SIGN IN
            </PrimaryButton>
            <GhostButton onPress={() => setSheet(null)}>KEEP THE SAMPLE</GhostButton>
          </View>
        </View>
      </BottomSheet>

      <BottomSheet open={sheet === 'how'} onClose={() => setSheet(null)} title="HOW THIS WORKS">
        <View className="gap-4 pb-2">
          <HowRow
            icon="sparkles"
            title="What it does"
            body="Reads your words and proposes a spec: the parameters a rule needs, written so a contract can check them."
          />
          <HowRow
            icon="sliders"
            title="What it chooses for you"
            body="Anything you did not say gets a default. Every default is listed and marked, and every one is editable."
          />
          <HowRow
            icon="ban"
            title="What it never does"
            body="Trade, pin a rule, or change one that is pinned. The contract checks signed prices with arithmetic and never calls a model."
          />
          <HowRow
            icon="check-circle"
            title="What is yours"
            body="The review. Nothing is enforced until you have read the spec and signed it."
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}

function Gap() {
  return <View className="h-4" />;
}

function ThreadSkeleton() {
  return (
    <View className="flex-1 gap-5 px-5 pt-5" aria-busy>
      <View className="gap-2">
        <Skeleton width={90} height={10} />
        <Skeleton width="78%" height={64} />
      </View>
      <View className="items-end gap-2">
        <Skeleton width={60} height={10} />
        <Skeleton width="60%" height={44} />
      </View>
      <View className="gap-2">
        <Skeleton width={90} height={10} />
        <Skeleton width="70%" height={88} />
      </View>
    </View>
  );
}

/**
 * A compile that did not land. Neutral by design: an outlined card, an info
 * glyph, what happened, and a retry. The user's words are kept, and it says so.
 */
function FailureNote({
  error,
  canRetry,
  onRetry,
}: {
  error: string | undefined;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const view = classifyFailure(error);
  return (
    <Enter variant="diff">
      <View role="status" className="gap-3 rounded-sm border border-hairline p-3.5">
        <View className="flex-row gap-2.5">
          <View className="pt-0.5">
            <Icon name="info" size={16} color="ash" />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-mono-medium text-11 uppercase tracking-w10 text-bone">{view.title}</Text>
            <Text className="font-sans text-13 leading-5 text-ash">{view.body}</Text>
          </View>
        </View>
        {canRetry ? (
          <Pressable
            role="button"
            aria-label="Retry the last message"
            onPress={onRetry}
            className="h-8 flex-row items-center gap-1.5 self-start rounded-xs border border-hairline bg-raised px-3 hover:bg-panel active:bg-panel"
          >
            <Icon name="refresh" size={14} color="bone" />
            <Text className="font-mono-medium text-12 tracking-w04 text-bone">Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </Enter>
  );
}

/** The next thing worth saying, under the newest turn. Tapping writes it into the box. */
function QuickReplies({
  suggestions,
  onPick,
}: {
  suggestions: ReadonlyArray<{ id: string; tag: string; text: string }>;
  onPick: (text: string) => void;
}) {
  return (
    <View className="gap-2.5">
      <SectionHeader title="Try next" />
      <View className="flex-row flex-wrap gap-2">
        {suggestions.map((s) => (
          <Pressable
            key={s.id}
            role="button"
            aria-label={`Use this prompt: ${s.text}`}
            onPress={() => onPick(s.text)}
            className={cx(
              'max-w-full rounded-xs border border-hairline bg-panel px-3 py-2',
              'hover:bg-raised active:bg-raised',
            )}
          >
            <Text className="font-sans text-13 leading-[18px] text-bone">{s.text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function HowRow({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <View className="flex-row gap-3">
      <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-panel">
        <Icon name={icon} size={16} color="ash" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="font-mono-medium text-11 uppercase tracking-w10 text-bone">{title}</Text>
        <Text className="font-sans text-13 leading-5 text-ash">{body}</Text>
      </View>
    </View>
  );
}
