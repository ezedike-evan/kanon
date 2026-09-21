/**
 * The runtime's series primitives: everything the chart draws that
 * lightweight-charts does not.
 *
 *   DrawingsPrimitive   the user's drawings, their selection handles and the
 *                       drawing in progress. One primitive paints them all in
 *                       one pane view, so N drawings cost one renderer.
 *   StructurePrimitive  the pinned rule's swing levels, gaps and sweeps.
 *   PriceTagPrimitive   the last-price tag on the price axis, with the bar
 *                       close countdown under the price.
 *
 * All three read live state through the `Scene` handed to them and never keep
 * a copy, so the runtime updates state and calls `requestUpdate`, nothing
 * else. Geometry comes from `lib/chart-drawings.ts`; this file only paints it.
 */
import type {
  IPrimitivePaneRenderer,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import {
  drawingShapes,
  handlesOf,
  type Bounds,
  type Projector,
  type Shape,
  type ShapeOptions,
} from '../../../lib/chart-drawings';
import { barClock } from '../../../lib/chart-timeframes';
import { formatCountdown, formatPrice, withAlpha } from '../../../lib/chart-format';
import type { ChartPalette, Drawing, StructureItem } from '../../../lib/chart-protocol';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface Scene {
  palette: ChartPalette;
  fontFamily: string;
  proj: Projector;
  bounds(): Bounds;
  shapeOptions(): ShapeOptions;
  /** Fractional-bar helper for extending boxes to the right. */
  barsToPx(bars: number): number;
}

const HANDLE_RADIUS = 5;

class PaneView {
  constructor(
    private readonly paint: (target: Target) => void,
    private readonly order: 'bottom' | 'normal' | 'top',
  ) {}
  zOrder() {
    return this.order;
  }
  renderer(): IPrimitivePaneRenderer {
    return { draw: (target) => this.paint(target) };
  }
}

abstract class BasePrimitive implements ISeriesPrimitive<Time> {
  protected requestUpdate: (() => void) | null = null;
  protected abstract readonly views: readonly PaneView[];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }
  detached(): void {
    this.requestUpdate = null;
  }
  paneViews() {
    return this.views;
  }
  redraw(): void {
    this.requestUpdate?.();
  }
}

function strokeShape(ctx: CanvasRenderingContext2D, s: Shape, scene: Scene, color: string): void {
  const { palette, fontFamily } = scene;
  if (s.t === 'seg') {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.lineWidth = s.role === 'main' ? 1.75 : 1;
    ctx.strokeStyle = s.role === 'level' ? withAlpha(color, 0.7) : s.role === 'guide' ? withAlpha(color, 0.6) : color;
    ctx.setLineDash(s.dash || s.role === 'guide' ? [4, 4] : []);
    ctx.stroke();
    ctx.restore();
  } else if (s.t === 'rect') {
    ctx.save();
    ctx.fillStyle = withAlpha(color, s.role === 'fill' ? 0.1 : 0.12);
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (s.role === 'main') {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
    }
    ctx.restore();
  } else {
    ctx.save();
    ctx.font = `${s.role === 'main' ? 600 : 400} 11px ${fontFamily}`;
    ctx.textAlign = s.anchor;
    ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(s.text).width;
    const left = s.anchor === 'left' ? s.x : s.anchor === 'right' ? s.x - w : s.x - w / 2;
    ctx.fillStyle = withAlpha(palette.background, 0.72);
    ctx.fillRect(left - 3, s.y - 11, w + 6, 15);
    ctx.fillStyle = s.role === 'main' ? palette.textStrong : withAlpha(color, 1);
    ctx.fillText(s.text, s.x, s.y);
    ctx.restore();
  }
}

export interface DrawingsView {
  drawings: readonly Drawing[];
  selectedId: string | null;
  /** The drawing being created (or the edited copy). Painted with handles. */
  draft: Drawing | null;
}

export class DrawingsPrimitive extends BasePrimitive {
  protected readonly views: readonly PaneView[];

  constructor(
    private readonly scene: () => Scene,
    private readonly view: () => DrawingsView,
  ) {
    super();
    this.views = [new PaneView((target) => this.paint(target), 'top')];
  }

  private paint(target: Target): void {
    const scene = this.scene();
    const { drawings, selectedId, draft } = this.view();
    if (drawings.length === 0 && !draft) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const bounds: Bounds = { width: mediaSize.width, height: mediaSize.height };
      const options = scene.shapeOptions();
      const color = scene.palette.drawing;
      for (const d of drawings) {
        for (const s of drawingShapes(d, scene.proj, bounds, options)) strokeShape(context, s, scene, color);
      }
      const focus = draft ?? drawings.find((d) => d.id === selectedId) ?? null;
      if (focus) {
        if (draft) for (const s of drawingShapes(draft, scene.proj, bounds, options)) strokeShape(context, s, scene, color);
        for (const h of handlesOf(focus, scene.proj, bounds)) {
          context.beginPath();
          context.arc(h.x, h.y, HANDLE_RADIUS, 0, Math.PI * 2);
          context.fillStyle = scene.palette.background;
          context.fill();
          context.lineWidth = 2;
          context.strokeStyle = color;
          context.stroke();
        }
      }
    });
  }
}

export class StructurePrimitive extends BasePrimitive {
  protected readonly views: readonly PaneView[];
  private items: readonly StructureItem[] = [];
  private visible = false;

  constructor(private readonly scene: () => Scene) {
    super();
    this.views = [new PaneView((target) => this.paint(target), 'normal')];
  }

  set(items: readonly StructureItem[], visible: boolean): void {
    this.items = items;
    this.visible = visible;
    this.redraw();
  }

  private paint(target: Target): void {
    if (!this.visible || this.items.length === 0) return;
    const scene = this.scene();
    const { palette, proj, fontFamily } = scene;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = `500 10px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      for (const item of this.items) {
        if (item.kind === 'swing') {
          const x1 = proj.x(item.time);
          const x2 = proj.x(item.endTime);
          const y = proj.y(item.price);
          if (x1 === null || x2 === null || y === null) continue;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = palette.rule;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = palette.rule;
          ctx.textAlign = 'center';
          ctx.fillText('BOS', (x1 + x2) / 2, item.side === 'high' ? y - 4 : y + 12);
        } else if (item.kind === 'fvg') {
          const x1 = proj.x(item.time);
          const x2 = proj.x(item.endTime);
          const yTop = proj.y(item.top);
          const yBottom = proj.y(item.bottom);
          if (x1 === null || x2 === null || yTop === null || yBottom === null) continue;
          const right = Math.min(mediaSize.width, x2 + scene.barsToPx(6));
          const tone = item.side === 'bull' ? palette.up : palette.down;
          ctx.fillStyle = withAlpha(tone, 0.16);
          ctx.fillRect(x1, Math.min(yTop, yBottom), right - x1, Math.abs(yBottom - yTop));
          ctx.strokeStyle = withAlpha(tone, 0.55);
          ctx.lineWidth = 1;
          ctx.strokeRect(x1, Math.min(yTop, yBottom), right - x1, Math.abs(yBottom - yTop));
          ctx.fillStyle = tone;
          ctx.textAlign = 'left';
          ctx.fillText('FVG', x1 + 3, Math.min(yTop, yBottom) - 3);
        } else {
          const x1 = proj.x(item.refTime);
          const x2 = proj.x(item.time);
          const yRef = proj.y(item.refPrice);
          const yWick = proj.y(item.price);
          if (x1 === null || x2 === null || yRef === null || yWick === null) continue;
          ctx.beginPath();
          ctx.moveTo(x1, yRef);
          ctx.lineTo(x2 + scene.barsToPx(2), yRef);
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = palette.verified;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(x2, yWick, 3, 0, Math.PI * 2);
          ctx.fillStyle = palette.verified;
          ctx.fill();
          ctx.textAlign = 'left';
          ctx.fillText('SWEEP', x2 + 6, item.side === 'low' ? yWick + 12 : yWick - 6);
        }
      }
      ctx.restore();
    });
  }
}

export interface TagState {
  price: number;
  lastCandleStart: number;
  bucketSeconds: number;
  decimals: number;
}

/**
 * The last-price tag. It sits on the price axis at the last close, price on
 * the first line and time to the bar's close on the second, the way TradingView
 * draws it. The countdown line is dropped when the feed is stale: a ticking
 * clock for a bar that is not forming would state something false.
 */
export class PriceTagPrimitive extends BasePrimitive {
  protected readonly views: readonly PaneView[];
  private state: TagState | null = null;

  constructor(
    private readonly scene: () => Scene,
    private readonly priceToY: (price: number) => number | null,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    super();
    this.views = [new PaneView((target) => this.paint(target), 'top')];
  }

  set(state: TagState | null): void {
    this.state = state;
    this.redraw();
  }

  /** Seconds tick; only this primitive repaints. */
  tick(): void {
    if (this.state) this.redraw();
  }

  priceAxisPaneViews() {
    return this.views;
  }
  override paneViews() {
    return [];
  }

  private paint(target: Target): void {
    const state = this.state;
    if (!state) return;
    const scene = this.scene();
    const y = this.priceToY(state.price);
    if (y === null) return;
    const clock = barClock(state.lastCandleStart, state.bucketSeconds, this.now());
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const h = clock.live ? 30 : 17;
      const top = Math.max(0, Math.min(mediaSize.height - h, y - h / 2));
      ctx.save();
      ctx.fillStyle = scene.palette.tagBackground;
      ctx.fillRect(0, top, mediaSize.width, h);
      ctx.fillStyle = scene.palette.tagText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `600 11px ${scene.fontFamily}`;
      const cx = mediaSize.width / 2;
      ctx.fillText(formatPrice(state.price, state.decimals), cx, top + 12);
      if (clock.live) {
        ctx.font = `400 10px ${scene.fontFamily}`;
        ctx.fillText(formatCountdown(clock.remaining), cx, top + 25);
      }
      ctx.restore();
    });
  }
}
