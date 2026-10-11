import { memo } from 'react';
import { Text, View } from 'react-native';
import { Link } from '../../nav';
import { useAccount } from '../../lib/account';
import { useKanonSelector } from '../../lib/data';
import { useSession } from '../../lib/domains';
import { greetingName, walletChip, type WalletChip as WalletChipView } from '../../lib/home-format';
import { routes } from '../../lib/routes';
import { Avatar } from '../avatar';
import { Icon } from '../icons';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { Dot, Num } from '../ui';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';

/**
 * Who is looking, and which wallet (if any) is signed in. The avatar opens Profile, where the
 * account and the connection are managed, and so does the chip once someone is signed in: it
 * states the wallet plainly, a short address when a signer exists. Signed out the chip is the
 * way to sign in and says so (`walletChip`); it never reports a wallet as failed.
 */
export const HomeHeader = memo(function HomeHeader() {
  const session = useSession();
  const settings = useKanonSelector((s) => s.settings);
  const account = useAccount();
  const name = greetingName(settings);

  const identity = session.pending ? null : name ?? (session.signedIn ? 'Trader' : 'Demo');
  const kicker = session.pending ? '' : session.signedIn ? 'Welcome back' : 'Demo account';

  return (
    <View className={cx('flex-row items-center gap-3', web('lg:border-b lg:border-hairline lg:pb-6'))}>
      <Link
        href={routes.profile}
        aria-label="Open profile"
        className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
      >
        <Avatar name={identity ?? '?'} size="md" tone={session.signedIn ? 'signal' : 'neutral'} />
        <View className="min-w-0 flex-1 gap-0.5">
          {identity === null ? (
            <>
              <Skeleton width={84} height={10} />
              <Skeleton width={120} height={16} />
            </>
          ) : (
            <>
              <Label>{kicker}</Label>
              <Text
                numberOfLines={1}
                className={cx('font-sans text-18 font-medium tracking-t20 text-bone', web('lg:text-24'))}
              >
                {identity}
              </Text>
            </>
          )}
        </View>
      </Link>
      <WalletChip
        chip={walletChip({
          pending: session.pending,
          signedIn: session.signedIn,
          hasWallet: session.hasWallet,
          address: account.address,
        })}
      />
    </View>
  );
});

function WalletChip({ chip }: { chip: WalletChipView | null }) {
  // Auth still resolving: the chip's own shape, and no claim about a wallet or a session.
  if (!chip) return <Skeleton width={96} height={32} />;
  const signIn = chip.to === 'signin';
  return (
    <Link
      href={signIn ? routes.landing : routes.profile}
      aria-label={chip.accessibilityLabel}
      className="h-8 shrink-0 flex-row items-center gap-1.5 rounded-xs border border-hairline bg-panel px-2.5 hover:bg-raised active:bg-raised"
    >
      <Icon name={signIn ? 'key' : 'wallet'} size={14} color="ash" />
      <Num className="text-11 text-bone">{chip.label}</Num>
      {/* A dot is a wallet's state. Signing in is an action, so it takes the chevron every link does. */}
      {signIn ? <Icon name="chevron-right" size={12} color="ash" /> : <Dot className={chip.connected ? 'bg-verified' : 'bg-ash'} />}
    </Link>
  );
}
