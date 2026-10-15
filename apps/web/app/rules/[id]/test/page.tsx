'use client';

import { use } from 'react';
import { BacktestScreen } from '@kanon/ui';

export default function RuleTestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <BacktestScreen ruleId={id} />;
}
