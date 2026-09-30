import { describe, expect, it } from 'vitest';
import { CliArgError, parseBoundedInt, parseEnvInt, parseHealthPort, parseIntervalArg } from './cli-args';

describe('parseBoundedInt', () => {
  it('accepts integers in range', () => {
    expect(parseBoundedInt('x', '15', { min: 1, max: 60 })).toBe(15);
    expect(parseBoundedInt('x', ' 1 ', { min: 1, max: 60 })).toBe(1);
  });
  it.each(['', 'abc', 'NaN', '1.5', '-3', '1e3', '0x10', '0', '61', '99999999999999999999'])('refuses %j', (raw) => {
    expect(() => parseBoundedInt('x', raw, { min: 1, max: 60 })).toThrow(CliArgError);
  });
  it('refuses undefined', () => {
    expect(() => parseBoundedInt('x', undefined, { min: 1, max: 60 })).toThrow(/x must be/);
  });
  it('does not echo the bad value', () => {
    try {
      parseBoundedInt('--interval', 'sekret', { min: 1, max: 60 });
    } catch (e) {
      expect((e as Error).message).not.toContain('sekret');
    }
  });
});

describe('parseIntervalArg', () => {
  it('uses the fallback when the flag is absent', () => expect(parseIntervalArg(['--watch'], 15)).toBe(15));
  it('reads the value', () => expect(parseIntervalArg(['--interval', '30'], 15)).toBe(30));
  it('a flag with no or a bad value is an error, not the default', () => {
    expect(() => parseIntervalArg(['--interval'], 15)).toThrow(CliArgError);
    expect(() => parseIntervalArg(['--interval', 'fast'], 15)).toThrow(CliArgError);
    expect(() => parseIntervalArg(['--interval', '0'], 15)).toThrow(CliArgError);
  });
});

describe('env ints', () => {
  it('health port is off unless set, and range-checked', () => {
    expect(parseHealthPort(undefined)).toBeUndefined();
    expect(parseHealthPort('')).toBeUndefined();
    expect(parseHealthPort('8080')).toBe(8080);
    expect(() => parseHealthPort('70000')).toThrow(CliArgError);
    expect(() => parseHealthPort('http')).toThrow(CliArgError);
  });
  it('parseEnvInt defaults when blank and rejects garbage', () => {
    expect(parseEnvInt('N', undefined, 300, { min: 1, max: 10 ** 6 })).toBe(300);
    expect(parseEnvInt('N', '60', 300, { min: 1, max: 10 ** 6 })).toBe(60);
    expect(() => parseEnvInt('N', 'abc', 300, { min: 1, max: 10 ** 6 })).toThrow(CliArgError);
  });
});
