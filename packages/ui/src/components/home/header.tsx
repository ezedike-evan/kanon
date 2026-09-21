import { memo } from 'react';
import { Text, View } from 'react-native';
import { Link } from '../../nav';
import { useAccount } from '../../lib/account';
import { useKanonSelector } from '../../lib/data';
import { useSession } from '../../lib/domains';
import { greetingName, shortAddress } from '../../lib/home-format';
import { routes } from '../../lib/routes';
import { Avatar } from '../avatar';
import { Icon } from '../icons';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { Dot, Num } from '../ui';

/**
 * Who is looking, and which wallet (if any) is signed in. The avatar and the wallet chip both open
 * Profile, where the account and the connection are managed. The connection is stated
 * plainly: a short address when a signer exists, "Not connected" when it does not.
 */
export const HomeHeader = memo(function HomeHeader() {
  const session = useSession();
  const settings = useKanonSelector((s) => s.settings);
  const account = useAccount();
  const name = greetingName(settings);

  const identity = session.pending ? null : name ?? (session.signedIn ? 'Trader' : 'Demo');
  const kicker = session.pending ? '' : session.signedIn ? 'Welcome back' : 'Demo account';

  return (
    <View className="flex-row items-center gap-3">
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
              <Text numberOfLines={1} className="font-sans text-18 font-medium tracking-t20 text-bone">
                {identity}
              </Text>
            </>
          )}
        </View>
      </Link>
      <WalletChip
        connected={session.hasWallet}
        address={account.address}
        signedIn={session.signedIn}
      />
    </View>
  );
});

function WalletChip({
  connected,
  address,
  signedIn,
}: {
  connected: boolean;
  address: string | null;
  signedIn: boolean;
}) {
  const label = connected ? (address ? shortAddress(address) : 'Wallet ready') : signedIn ? 'No wallet' : 'Not connected';
  return (
    <Link
      href={routes.profile}
      aria-label={connected ? `Wallet ${address ?? 'connected'}` : 'Wallet not connected'}
      className="h-8 shrink-0 flex-row items-center gap-1.5 rounded-xs border border-hairline bg-panel px-2.5 hover:bg-raised active:bg-raised"
    >
      <Icon name="wallet" size={14} color="ash" />
      <Num className="text-11 text-bone">{label}</Num>
      <Dot className={connected ? 'bg-verified' : 'bg-ash'} />
    </Link>
  );
}
