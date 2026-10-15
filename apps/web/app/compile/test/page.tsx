'use client';

import { BacktestScreen } from '@kanon/ui';

// A page's default export takes only what Next passes it, so the screen is mounted, not re-exported:
// it has its own optional `ruleId`, which this route (the draft under review) does not set.
export default function CompileTestPage() {
  return <BacktestScreen />;
}
