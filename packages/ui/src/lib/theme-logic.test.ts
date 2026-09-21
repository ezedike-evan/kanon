import { describe, expect, it } from 'vitest';
import { colors, hexToTriplet, lightColors, themeBootScript, themeVars } from '@kanon/tokens';
import { contrastRatio, isThemeMode, resolveScheme } from './theme-logic';

describe('resolveScheme', () => {
  it('honours an explicit choice regardless of the OS', () => {
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('light', 'dark')).toBe('light');
  });

  it('follows the OS for system, and falls back to dark when it is unknown', () => {
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', null)).toBe('dark');
    expect(resolveScheme('system', undefined)).toBe('dark');
  });
});

describe('isThemeMode', () => {
  it('only accepts the three modes', () => {
    expect(['dark', 'light', 'system'].every(isThemeMode)).toBe(true);
    expect(isThemeMode('auto')).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe('palettes', () => {
  it('define exactly the same tokens in both themes', () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(colors).sort());
  });

  it('turns hex into the triplet Tailwind reads', () => {
    expect(hexToTriplet('#0B0D10')).toBe('11 13 16');
    expect(themeVars('dark')['--c-void']).toBe('11 13 16');
    expect(themeVars('light')['--c-void']).toBe('242 244 247');
  });

  // The light palette exists to be readable. Text-bearing tokens must clear
  // WCAG AA (4.5:1) on both grounds, in both themes.
  const TEXT = ['bone', 'ash', 'signal', 'long', 'short', 'refused', 'verified'] as const;
  for (const [name, palette] of [['dark', colors], ['light', lightColors]] as const) {
    for (const token of TEXT) {
      it(`${name}: ${token} clears 4.5:1 on panel and void`, () => {
        expect(contrastRatio(palette[token], palette.panel)).toBeGreaterThanOrEqual(4.45);
        expect(contrastRatio(palette[token], palette.void)).toBeGreaterThanOrEqual(4.45);
      });
    }
  }

  it('keeps refused distinct from short in both themes', () => {
    expect(colors.refused).not.toBe(colors.short);
    expect(lightColors.refused).not.toBe(lightColors.short);
  });
});

describe('boot script', () => {
  it('reads the same storage key the provider writes, and defaults to dark', () => {
    expect(themeBootScript).toContain('kanon.theme');
    expect(themeBootScript).toContain("'dark'");
  });
});
