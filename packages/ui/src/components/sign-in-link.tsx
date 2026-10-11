import { Text } from 'react-native';
import { cx } from '../lib/cx';
import { web } from '../lib/desktop';
import { routes } from '../lib/routes';
import { SIGN_IN_ACTION } from '../lib/venue-trade';
import { Link } from '../nav';
import { Icon } from './icons';

/**
 * "Sign in to trade", as something to press. Wherever a visitor who has not
 * signed in is told that trading needs an account, the sentence is the way to
 * one: it leads to the front door (`routes.landing`). Drawn as the app's other
 * links are, in `verified` with a chevron, so it does not read as a fault or as
 * a line of status.
 */
export function SignInLink({
  lead,
  size = 11,
  className,
}: {
  /** A plain statement set before the link, in `ash`: `Sample prices.` */
  lead?: string | undefined;
  /** The type size of the line it stands in for. */
  size?: 10 | 11;
  className?: string | undefined;
}) {
  const type = size === 10 ? 'text-10' : 'text-11';
  return (
    <Link
      href={routes.landing}
      aria-label={lead ? `${lead} ${SIGN_IN_ACTION}` : SIGN_IN_ACTION}
      hitSlop={10}
      className={cx(
        'flex-row items-center gap-1.5 rounded-xs hover:opacity-80 active:opacity-70',
        web('outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal'),
        className,
      )}
    >
      {lead ? <Text className={cx('shrink font-mono leading-4 text-ash', type)}>{lead}</Text> : null}
      <Text className={cx('font-mono-medium leading-4 text-verified', type)}>{SIGN_IN_ACTION}</Text>
      <Icon name="chevron-right" size={12} color="verified" strokeWidth={2} />
    </Link>
  );
}
