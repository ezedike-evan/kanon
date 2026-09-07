'use client';

import { use } from 'react';
import { TradeDetailScreen } from '@kanon/ui';

export default function TradeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <TradeDetailScreen id={id} />;
}
