import { memo } from 'react';
import { Text, View } from 'react-native';
import { formatDecimal } from '@kanon/spec';
import { useKanonSelector } from '../../lib/data';
import { cx } from '../../lib/cx';
import { routes } from '../../lib/routes';
import { Card } from '../card';
import { ListRow } from '../list-row';
import { Label } from '../stat';
import { Num } from '../ui';

/**
 * Below the fold, small, and last: the verified 30-day P&L and the way to the
 * analysis. It is deliberately quiet. Profit is a result, not a reason, and
 * leading with it drives the behaviour this product exists to prevent.
 */
export const HomeFoot = memo(function HomeFoot({
  part = 'all',
  className,
}: {
  /**
   * `all` is the phone's foot: the shortcuts, then the P&L line. Desktop splits it,
   * so the shortcuts sit in the side column and the P&L stays the last, quietest
   * thing on the page: `shortcuts` and `pnl`.
   */
  part?: 'all' | 'shortcuts' | 'pnl';
  className?: string | undefined;
}) {
  const foot = useKanonSelector(
    (s) => ({ live: s.mode === 'live', pnl30d: s.home.pnl30d }),
    (a, b) => a.live === b.live && a.pnl30d.atoms === b.pnl30d.atoms,
  );

  return (
    <View className={cx('gap-3', className)}>
      {part === 'pnl' ? null : <Shortcuts />}
      {part === 'shortcuts' ? null : (
        <View
          className={cx(
            'flex-row items-baseline justify-between gap-3 px-1',
            part === 'pnl' && 'border-t border-hairline pt-4',
          )}
        >
          <View className="flex-1 gap-0.5">
            <Label>Verified P&amp;L · 30d</Label>
            <Text className="font-sans text-11 leading-[1.4] text-ash">
              {foot.live ? 'Shown once closed trades have been verified.' : 'Sample figure. Not yours.'}
            </Text>
          </View>
          <Num className="text-12 text-ash">{foot.live ? '—' : formatDecimal(foot.pnl30d, { signed: true })}</Num>
        </View>
      )}
    </View>
  );
});

function Shortcuts() {
  return (
    <Card pad="none">
      <ListRow
        leading="bar-chart"
        title="Analytics"
        subtitle="Adherence, risk and smart-money flow"
        href={routes.analytics}
      />
      <ListRow
        leading="vault"
        title="Guarded vault"
        subtitle="Funds an agent can trade inside your rule"
        href={routes.vault}
        divider={false}
      />
    </Card>
  );
}
