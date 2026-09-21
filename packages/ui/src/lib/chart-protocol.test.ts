import { describe, expect, it } from 'vitest';
import { parseRuntimeEvent } from './chart-protocol';

describe('bridge events', () => {
  it('parses the events the runtime sends', () => {
    expect(parseRuntimeEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseRuntimeEvent('{"type":"crosshair","candle":null}')).toEqual({ type: 'crosshair', candle: null });
    expect(parseRuntimeEvent('{"type":"error","message":"x"}')).toEqual({ type: 'error', message: 'x' });
  });

  it('drops anything else without throwing', () => {
    expect(parseRuntimeEvent('not json')).toBeNull();
    expect(parseRuntimeEvent('null')).toBeNull();
    expect(parseRuntimeEvent('42')).toBeNull();
    expect(parseRuntimeEvent('{"type":"launch"}')).toBeNull();
    expect(parseRuntimeEvent('{}')).toBeNull();
  });
});

describe('layout event', () => {
  it('carries the measured price axis width', () => {
    expect(parseRuntimeEvent('{"type":"layout","priceAxisWidth":80}')).toEqual({ type: 'layout', priceAxisWidth: 80 });
  });
});
