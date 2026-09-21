import { describe, expect, it } from 'vitest';
import { accountChipOf } from './account-chip';
import type { ProfileState } from './domain-types';

const records = { rulesPinned: 0, taken: 0, refused: 0 } as never;
const ready = (name: string, username: string, email: string | null = null): ProfileState => ({
  status: 'ready',
  settings: { name, username, email, hasWallet: true },
  records,
  rules: [],
  following: [],
});
const settled = { pending: false };

describe('accountChipOf', () => {
  it('says nothing it might take back while loading', () => {
    expect(accountChipOf({ status: 'loading' }, settled)).toEqual({ name: 'Loading', sub: '', demo: false });
    expect(accountChipOf(ready('Ada', 'ada'), { pending: true }).name).toBe('Loading');
  });

  it('labels the signed-out account as the demo', () => {
    const demo: ProfileState = { ...(ready('x', 'x') as object), status: 'demo' } as ProfileState;
    expect(accountChipOf(demo, settled)).toEqual({ name: 'Kanon Demo', sub: 'DEMO ACCOUNT', demo: true });
  });

  it('shows the name and the @handle of a signed-in user', () => {
    expect(accountChipOf(ready('Ada Lovelace', 'ada'), settled)).toEqual({
      name: 'Ada Lovelace',
      sub: '@ada',
      demo: false,
    });
  });

  it('falls back to the email, then to nothing, when there is no username', () => {
    expect(accountChipOf(ready('Ada', '', 'ada@example.com'), settled).sub).toBe('ada@example.com');
    expect(accountChipOf(ready('Ada', ''), settled).sub).toBe('');
  });

  it('never shows a blank name', () => {
    expect(accountChipOf(ready('   ', 'ada'), settled).name).toBe('Unnamed');
  });

  it('asks a nameless account to finish signing up', () => {
    expect(accountChipOf({ status: 'empty' }, settled).name).toBe('Finish signing up');
  });
});
