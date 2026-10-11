import { useCallback, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { web } from '../lib/desktop';
import { updatePreferences, usePreference, type PanelPreference, type Preferences } from '../lib/preferences';
import { usePlatform } from '../platform';
import { IconButton } from './icon-button';

/*
 * A desktop side panel that shrinks to a rail.
 *
 * Open, a panel carries a `PanelToggle` in the top corner at its outer edge.
 * Collapsed, it is a `PanelRail`: 40px, the width of the chart's tool rail,
 * with the same border, holding the toggle that opens it again and a caption
 * that names what is behind it. The choice is a device preference
 * (`lib/preferences.ts`), remembered per panel.
 *
 * Both pieces are `hidden` below their breakpoint by class, as the panels are,
 * so a phone and a tablet draw neither. The change is a snap, not a slide: an
 * animated width would resize the chart beside it on every frame.
 */

/** The edge of the pane a panel sits on. Its border faces the content and its chevrons point the way it moves. */
export type PanelSide = 'left' | 'right';

/**
 * Whether a side panel is open, and the setter that remembers the answer on
 * this device. Open until the stored choice has been read, which is also the
 * default, so the common case paints once and stays. The desktop navigation
 * keeps its own open-or-rail choice through this too (`sideNavOpen`).
 */
export function usePanelOpen(key: PanelPreference): [open: boolean, setOpen: (open: boolean) => void] {
  const open = usePreference(key);
  const { storage } = usePlatform();
  const setOpen = useCallback(
    (next: boolean) => {
      const patch: Partial<Preferences> = {};
      patch[key] = next;
      updatePreferences(patch, storage);
    },
    [key, storage],
  );
  return [open, setOpen];
}

/** Keyboard focus, drawn as the side nav draws it. */
const FOCUS = web(
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal',
);

/**
 * The one control that opens or collapses a panel. Its chevron points the way
 * the panel's edge will move, and its name says what it shows or hides.
 */
export function PanelToggle({
  side,
  open,
  name,
  onToggle,
  className,
}: {
  side: PanelSide;
  open: boolean;
  /** What the panel holds, in lower case, to follow "Show" or "Hide": `markets and order ticket`. */
  name: string;
  onToggle: () => void;
  className?: string | undefined;
}) {
  const outward = side === 'right' ? 'chevron-right' : 'chevron-left';
  const inward = side === 'right' ? 'chevron-left' : 'chevron-right';
  return (
    <IconButton
      icon={open ? outward : inward}
      label={open ? `Hide ${name}` : `Show ${name}`}
      expanded={open}
      size="sm"
      color={open ? 'ash' : 'bone'}
      onPress={onToggle}
      className={cx(FOCUS, className)}
    />
  );
}

/**
 * A collapsed panel. `children` sit under the toggle, for the little a rail
 * must still say (the chart's open position). The caption is for the eye; the
 * toggle's own name already says it to a screen reader.
 */
export function PanelRail({
  side,
  from = 'lg',
  label,
  name,
  caption,
  onOpen,
  children,
}: {
  side: PanelSide;
  /** The breakpoint the panel itself appears from. */
  from?: 'lg' | 'xl';
  /** The landmark's name, the same one the open panel has. */
  label: string;
  name: string;
  /** What is behind the rail, in a few words. Drawn down the rail. */
  caption: string;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <View
      role="complementary"
      aria-label={label}
      className={cx(
        'hidden min-h-0 w-10 shrink-0 items-center gap-2.5 overflow-hidden border-hairline bg-panel pb-3 pt-2.5',
        side === 'right' ? 'border-l' : 'border-r',
        from === 'xl' ? 'xl:flex' : 'lg:flex',
      )}
    >
      <PanelToggle side={side} open={false} name={name} onToggle={onOpen} />
      {children}
      <Text
        aria-hidden
        className="font-mono text-10 uppercase tracking-w14 text-ash"
        // Web only, as the rail is: the caption reads down the rail, on one line.
        style={{ writingMode: 'vertical-rl', whiteSpace: 'nowrap' } as never}
      >
        {caption}
      </Text>
    </View>
  );
}
