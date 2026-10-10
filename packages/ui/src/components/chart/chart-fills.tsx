import { Component, useEffect, type ReactNode } from 'react';
import { useVenueOrders } from '../../lib/domains';
import type { VenueOrder } from '../../lib/venue-types';

/** What the feed reports before anything is read, when signed out, and when the list cannot be read. */
export const NO_ORDERS: readonly VenueOrder[] = [];

interface FeedProps {
  /** The caller's own orders, newest first, each time the list changes. None when it cannot be read. */
  onOrders: (orders: readonly VenueOrder[]) => void;
}

function Subscription({ onOrders }: FeedProps) {
  const state = useVenueOrders();
  const orders = state.status === 'ready' ? state.orders : NO_ORDERS;
  useEffect(() => {
    onOrders(orders);
  }, [orders, onOrders]);
  return null;
}

/**
 * A read of the order list that throws must not take the chart with it. The
 * candles, the rule and the ticket do not depend on it; the fills are simply
 * not marked.
 */
class Boundary extends Component<FeedProps & { children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onOrders(NO_ORDERS);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The chart's subscription to the caller's own orders, so their fills can be
 * marked on the candles. It draws nothing. The subscription lives exactly as
 * long as this is mounted, which is as long as the chart is.
 */
export function VenueOrdersFeed({ onOrders }: FeedProps) {
  return (
    <Boundary onOrders={onOrders}>
      <Subscription onOrders={onOrders} />
    </Boundary>
  );
}
