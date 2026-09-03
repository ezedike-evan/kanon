import type { Route } from 'next';
import Link from 'next/link';
import { device } from '@kanon/tokens';
import { RULE, TRADE_ID } from '@/lib/demo';
import { loosenRoute, shareRoute, tradeRoute } from '@/lib/routes';

/**
 * The canvas: every screen at artboard size, in order, the way the design
 * document presents them. This is the consistency check `docs/DESIGN.md` asks
 * for — number treatment across rule-card, proposal, trade-detail and
 * blocked-log has to read as one instrument, and drift is only visible side by
 * side.
 *
 * Each frame is the real route, not a copy of it.
 */
const SCREENS: Array<{ label: string; href: Route }> = [
  { label: '00 · REFUSAL', href: '/refused' },
  { label: '01 · RULE CARD (HOME)', href: '/' },
  { label: '02 · CHAT-TO-SPEC COMPILER', href: '/compile' },
  { label: '03 · SPEC REVIEW', href: '/compile/review' },
  { label: '04 · PINNING CEREMONY', href: '/compile/pin' },
  { label: '05 · TRADE PROPOSAL · UNDO WINDOW', href: '/trades/proposal' },
  { label: '06 · TRADE DETAIL · EVIDENCE', href: tradeRoute(TRADE_ID) },
  { label: '07 · BLOCKED TRADES LOG', href: '/blocked' },
  { label: '08 · COOLING-OFF', href: loosenRoute(RULE.id) },
  { label: '09 · SHAREABLE STRATEGY CARD', href: shareRoute(RULE.id) },
  { label: '10A · ONBOARDING · PASSKEY', href: '/onboarding' },
  { label: '10B · ONBOARDING · FUND', href: '/onboarding/fund' },
  { label: '10C · ONBOARDING · FIRST STRATEGY', href: '/onboarding/strategy' },
];

export const metadata = { title: 'Kanon · Screens' };

export default function ScreensPage() {
  return (
    <main className="min-h-dvh bg-canvas p-14">
      <div className="mb-10 flex flex-col gap-2">
        <h1 className="font-mono text-12 font-bold tracking-w22">KANON</h1>
        <p className="font-mono text-11 tracking-w16 text-ash">
          {SCREENS.length} SCREENS · <span className="tabular-nums">{device.width}</span>
          {' × '}
          <span className="tabular-nums">{device.height}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-x-10 gap-y-14">
        {SCREENS.map((screen) => (
          <div key={screen.label} className="flex flex-col gap-3">
            <Link
              href={screen.href}
              className="font-mono text-11 tracking-w16 text-ash hover:text-bone"
            >
              {screen.label}
            </Link>
            <iframe
              src={screen.href}
              title={screen.label}
              width={device.width}
              height={device.height}
              loading="lazy"
              className="border-0 bg-void"
            />
          </div>
        ))}
      </div>
    </main>
  );
}
