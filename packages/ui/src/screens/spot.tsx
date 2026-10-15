import { useCallback, useEffect, useState } from 'react';
import { Body, Col, Row, Screen, StatusBar, TabBar } from '../components/chrome';
import { SubHeader } from '../components/profile-parts';
import { SectionHeader } from '../components/section-header';
import { BestPrices, Book, MarketHead, SpotSkeleton, SpotUnavailable, ThisMarket } from '../components/spot/spot-book';
import { ActionBar, OrderSheet, TicketCard } from '../components/spot/spot-ticket';
import { useSpotTicket } from '../lib/use-spot-ticket';

/**
 * 17 · SPOT.
 *
 * The one market Kanon listed on Kuru's testnet order book, tkBTC/USDC: its
 * book and best prices, read from the gateway and shown to anyone, and a ticket
 * that sends a market order from the signed-in person's own wallet. tkBTC is a
 * test token and USDC here is a mock: every label says so, and nothing presents
 * either as the real thing.
 *
 * Above the fold is the market and its book. An order is one press on the foot
 * of the screen to open the confirmation, a bottom sheet that states exactly
 * what will be sent, and one press there to send it. What comes back is a size
 * and a price with its transaction, never money made or lost.
 */
export function SpotScreen() {
  const ticket = useSpotTicket();
  const { feed, market } = ticket;
  const [reviewing, setReviewing] = useState(false);

  // A confirmation is for the order about to be sent, so the last one's answer does not ride along into it.
  const { dismiss } = ticket;
  const review = useCallback(() => {
    dismiss();
    setReviewing(true);
  }, [dismiss]);
  const close = useCallback(() => setReviewing(false), []);
  // With no market there is nothing to confirm. The sheet does not come back by itself when one returns.
  useEffect(() => {
    if (!market) setReviewing(false);
  }, [market]);

  return (
    <Screen size="column" desktop="wide">
      <StatusBar />
      <SubHeader kicker="Kuru testnet" title="Spot market" />
      <Body contentClassName="gap-6 pb-8 pt-2">
        {feed.status === 'loading' ? (
          <SpotSkeleton />
        ) : feed.status === 'unavailable' ? (
          <SpotUnavailable code={feed.code} message={feed.message} />
        ) : (
          <>
            <MarketHead market={feed.market} />
            <BestPrices market={feed.market} />
            <Row align="start">
              <Col span={7} gap="sm">
                <SectionHeader title="Order book" />
                <Book market={feed.market} stale={feed.failed} />
              </Col>
              <Col span={5} gap="sm">
                <SectionHeader title="Trade" />
                <TicketCard ticket={ticket} market={feed.market} />
              </Col>
            </Row>
            <ThisMarket market={feed.market} />
          </>
        )}
      </Body>
      {market ? <ActionBar ticket={ticket} onReview={review} /> : null}
      <TabBar active="profile" />
      {market ? <OrderSheet open={reviewing} onClose={close} ticket={ticket} market={market} /> : null}
    </Screen>
  );
}
