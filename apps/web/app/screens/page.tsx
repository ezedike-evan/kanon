'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { device } from '@kanon/tokens';
import { SCREEN_INDEX } from '@kanon/ui';

/**
 * The canvas: every screen at artboard size, in order, the way the design
 * document presents them. This is the consistency check `docs/DESIGN.md` asks
 * for — number treatment across rule-card, proposal, trade-detail and
 * blocked-log has to read as one instrument, and drift is only visible side by
 * side.
 *
 * Each frame is the real route, not a copy of it. This page is the one thing
 * the browser can do that a phone cannot, so it is the one screen that lives
 * here rather than in `@kanon/ui`.
 */
export default function ScreensPage() {
  return (
    <main className="min-h-dvh bg-canvas p-14">
      <div className="mb-10 flex flex-col gap-2">
        <h1 className="font-mono-bold text-12 tracking-w22 text-bone">KANON</h1>
        <p className="font-mono text-11 tracking-w16 text-ash">
          {SCREEN_INDEX.length} SCREENS · {device.width} × {device.height}
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-x-10 gap-y-14">
        {SCREEN_INDEX.map((screen) => (
          <div key={screen.label} className="flex flex-col gap-3">
            <Link
              href={screen.href as Route}
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
