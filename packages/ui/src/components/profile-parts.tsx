import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { COOLING_OFF_SECONDS } from '@kanon/spec';
import { Screen, StatusBar, TabBar } from './chrome';
import { BottomSheet } from './bottom-sheet';
import { Icon } from './icons';
import { Label } from './stat';
import { GhostButton, Num } from './ui';
import { Link, useNavigator } from '../nav';
import { useAccount } from '../lib/account';
import { routes } from '../lib/routes';
import { usePlatform, useHaptics } from '../platform';

/**
 * Pieces the Profile tab's screens share: the sub-screen frame with its way
 * back, the copy button, and the two sheets (sign out, what the contract
 * enforces) that both the profile home and the security screen open.
 */

/** A title with a way back to the Profile tab, and an optional right-hand slot. */
export function SubHeader({
  title,
  kicker = 'Profile',
  right,
}: {
  title: string;
  kicker?: string | undefined;
  right?: ReactNode;
}) {
  return (
    <View className="shrink-0 flex-row items-center gap-3 px-5 pb-3 pt-4">
      <Link
        href={routes.profile}
        aria-label="Back to profile"
        className="size-10 items-center justify-center rounded-sm border border-hairline bg-panel hover:bg-raised active:bg-raised"
      >
        <Icon name="chevron-left" size={18} color="bone" />
      </Link>
      <View className="flex-1 gap-0.5">
        <Label>{kicker}</Label>
        <Text role="heading" numberOfLines={1} className="font-sans text-18 font-medium tracking-t20 text-bone">
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

/** Screen, status bar, header and the tab bar with Profile lit: the frame every sub-screen sits in. */
export function SubScreen({
  label,
  title,
  right,
  children,
  overlay,
}: {
  label: string;
  title: string;
  right?: ReactNode;
  children: ReactNode;
  /** Sheets: rendered after the tab bar so they rise over it. */
  overlay?: ReactNode;
}) {
  return (
    <Screen label={label}>
      <StatusBar />
      <SubHeader title={title} right={right} />
      {children}
      <TabBar active="profile" />
      {overlay}
    </Screen>
  );
}

/**
 * Puts `value` on the clipboard and says so for a moment. A failure says that
 * too: a copy that did not happen is never shown as one that did.
 */
export const CopyButton = memo(function CopyButton({ value, label }: { value: string; label: string }) {
  const { copy } = usePlatform();
  const { success, tap } = useHaptics();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const press = useCallback(async () => {
    const ok = await copy(value);
    if (ok) success();
    else tap();
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  }, [copy, value, success, tap]);

  return (
    <Pressable
      role="button"
      aria-label={state === 'copied' ? `${label} copied` : `Copy ${label}`}
      onPress={press}
      hitSlop={6}
      className="h-8 flex-row items-center gap-1.5 rounded-sm border border-hairline bg-panel px-2.5 hover:bg-raised active:bg-raised"
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} color={state === 'copied' ? 'long' : 'ash'} />
      <Text className="font-mono-medium text-11 uppercase tracking-w08 text-ash">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Not copied' : 'Copy'}
      </Text>
    </Pressable>
  );
});

/** A label over a monospaced value, one per line of a fact sheet. */
export function Fact({
  label,
  value,
  sub,
  right,
  mono = true,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  right?: ReactNode;
  /** Figures, addresses and hashes are monospaced; a plain phrase is not. */
  mono?: boolean | undefined;
}) {
  return (
    <View className="min-h-14 flex-row items-center gap-3 border-b border-hairline px-4 py-3">
      <View className="flex-1 gap-1">
        <Label>{label}</Label>
        {mono ? (
          <Num className="text-13">{value}</Num>
        ) : (
          <Text className="font-sans text-14 text-bone">{value}</Text>
        )}
        {sub ? <Text className="font-sans text-12 text-ash">{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/** Ends the session, then leaves for the front door. Nothing on-chain changes. */
export function SignOutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const account = useAccount();
  const nav = useNavigator();
  const { warning } = useHaptics();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await account.signOut();
      warning();
      onClose();
      nav.replace(routes.landing);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="SIGN OUT">
      <View className="gap-4 pb-2">
        <Text className="font-sans text-14 leading-[1.5] text-bone">
          This ends the session on this device. Your rules stay pinned on-chain and keep refusing what breaks them.
        </Text>
        <Text className="font-sans text-13 leading-[1.5] text-ash">
          Signing out changes nothing about a rule, and it is not a way around a cooling-off.
        </Text>
        {failed ? (
          <Text role="alert" className="font-sans text-13 text-ash">
            The session did not end. Try again.
          </Text>
        ) : null}
        <GhostButton onPress={run} disabled={busy}>
          {busy ? 'SIGNING OUT' : 'SIGN OUT'}
        </GhostButton>
      </View>
    </BottomSheet>
  );
}

/** What the contract enforces, in plain words. The same six facts `docs/ARCHITECTURE.md` rests on. */
export function ContractSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hours = Math.round(COOLING_OFF_SECONDS / 3600);
  const points: ReadonlyArray<readonly [string, string]> = [
    ['Signatures and arithmetic', 'The contract checks a signature and does arithmetic on signed prices. That is all it does.'],
    ['No model inside', 'It never calls an AI model, directly or through anyone else. Nothing that thinks is in the path.'],
    ['A refusal names its number', 'A trade that fails your pinned rule is refused, with the predicate that failed and the figure that failed it.'],
    ['Tighten now, loosen later', `Tightening a rule applies at once. Loosening one waits ${hours} hours, in view, and cannot be skipped.`],
    ['No override', 'There is no admin key and no support path. A way around the rule would be used, so there is none.'],
    ['A challenger, not a judge', 'A second AI may challenge a claim, but only with evidence that makes it arithmetically false. Its opinion carries no weight.'],
  ];
  return (
    <BottomSheet open={open} onClose={onClose} title="WHAT THE CONTRACT ENFORCES">
      <View className="gap-4 pb-2">
        {points.map(([title, body], i) => (
          <View key={title} className="flex-row gap-3">
            <Num className="w-5 pt-0.5 text-11 text-signal">{String(i + 1).padStart(2, '0')}</Num>
            <View className="flex-1 gap-1">
              <Text className="font-sans text-14 font-medium text-bone">{title}</Text>
              <Text className="font-sans text-13 leading-[1.5] text-ash">{body}</Text>
            </View>
          </View>
        ))}
        <Text className="border-t border-hairline pt-3 font-sans text-12 leading-[1.5] text-ash">
          The full write-up is docs/ARCHITECTURE.md in the Kanon repository.
        </Text>
      </View>
    </BottomSheet>
  );
}
