import { describe, expect, it } from 'vitest';
import { createRoute, routes } from './routes';

describe('createRoute', () => {
  it('opens the AI tab with the prompt in the query, encoded', () => {
    const href = createRoute('Only long BTC/USD, risk 0.5% & no trades before 09:30');
    expect(href.startsWith(`${routes.create}?prompt=`)).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('prompt')).toBe('Only long BTC/USD, risk 0.5% & no trades before 09:30');
  });
});
