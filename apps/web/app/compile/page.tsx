import { Footer, Screen, StatusBar } from '@/components/chrome';
import { Dot, Num, PrimaryButton } from '@/components/ui';
import { COMPILER } from '@/lib/demo';
import { cx } from '@/lib/cx';

/**
 * 02 · CHAT-TO-SPEC COMPILER.
 *
 * Chat above, live spec diff below. The model's job here is translation, not
 * prediction — you watch your own language turn into an object a dumb machine
 * can check, and nothing is pinned until you have reviewed it.
 */
export default function CompilePage() {
  const changed = COMPILER.lines.filter((l) => l.changed).length;

  return (
    <Screen label="02 · CHAT-TO-SPEC COMPILER">
      <StatusBar />
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-5 pt-5 pb-4">
        <span className="font-mono text-11 tracking-w16">COMPILER</span>
        <span className="font-mono text-10 tracking-w12 text-ash">{COMPILER.draft}</span>
      </div>

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {COMPILER.transcript.map((turn, i) => {
          const mine = turn.from === 'YOU';
          return (
            <div
              key={i}
              className={cx('flex flex-col gap-2', mine && 'items-end')}
            >
              <span className="font-mono text-9 tracking-w20 text-ash">
                {turn.from} · <Num>{turn.at}</Num>
              </span>
              <div
                className={cx(
                  'text-14 leading-[1.5] text-pretty',
                  mine
                    ? 'border border-hairline bg-raised px-3.5 py-3.25'
                    : 'text-ash',
                )}
              >
                {turn.text}
              </div>
            </div>
          );
        })}
      </div>

      {/* The spec, live. Changed lines fade up in `signal` and settle. */}
      <div className="shrink-0 border-t border-hairline bg-sunken">
        <div className="flex items-center justify-between px-5 pt-3.5 pb-2.5">
          <span className="font-mono text-9 tracking-w20 text-ash">COMPILED SPEC</span>
          <span className="font-mono text-9 tracking-w16 text-signal">
            +{changed} CHANGED
          </span>
        </div>
        <div className="flex flex-col px-5 pb-4 font-mono text-12 leading-[1.85]">
          {COMPILER.lines.map((line, i) => (
            <div
              key={line.text}
              className={cx(
                'flex gap-3',
                line.changed
                  ? 'animate-diff bg-diff-wash text-signal'
                  : 'text-ash',
              )}
            >
              <Num className={cx('w-4', line.changed ? 'text-diff-gutter' : 'text-hairline')}>
                {String(i + 1).padStart(2, '0')}
              </Num>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
        <Footer className="flex items-center justify-between border-t border-hairline bg-panel px-5 pt-3">
          <div className="flex items-center gap-2.25">
            <Dot className="bg-signal" />
            <span className="font-mono text-11 tracking-w08 text-ash">
              <Num>{changed}</Num> UNSAVED CHANGES
            </span>
          </div>
          <PrimaryButton
            href="/compile/review"
            className="w-auto px-4 py-3 text-11 tracking-w14"
          >
            REVIEW &amp; PIN
          </PrimaryButton>
        </Footer>
      </div>
    </Screen>
  );
}
