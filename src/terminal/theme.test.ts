import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  colorCode,
  DARK,
  editorThemeKind,
  hex,
  LIGHT,
  paletteFor,
  parseColorDepth,
  SESSION_COLOR_RESET,
  sessionColorSequence,
  sessionColorsFor,
  to16,
  to256,
  type Rgb,
  type Role,
} from './theme';

/** WCAG 2 contrast ratio between two colors. */
function contrast(a: Rgb, b: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb: Rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('Easy SSH palettes', () => {
  it('follows the kind of VS Code theme: light and high-contrast light get Light', () => {
    assert.equal(paletteFor('light'), LIGHT);
    assert.equal(paletteFor('dark'), DARK);
    assert.equal(editorThemeKind(1), 'light');
    assert.equal(editorThemeKind(2), 'dark');
    assert.equal(editorThemeKind(3), 'dark');
    assert.equal(editorThemeKind(4), 'light');
  });

  it('reads only known color depths', () => {
    assert.equal(parseColorDepth('256'), '256');
    assert.equal(parseColorDepth('16'), '16');
    assert.equal(parseColorDepth(undefined), 'truecolor');
  });

  it('keeps the brand hues of the icon and leaves the background to VS Code', () => {
    assert.deepEqual(DARK.badgeFrom, hex('#8B5CF6'));
    assert.deepEqual(DARK.badgeTo, hex('#EC4899'));
    assert.deepEqual(DARK.fg.accent, hex('#B39DFA'));
    assert.deepEqual(LIGHT.fg.accent, hex('#6D28D9'));
    assert.deepEqual(DARK.canvas, hex('#1F1F1F'));
    assert.deepEqual(LIGHT.canvas, hex('#FFFFFF'));
  });

  for (const palette of [DARK, LIGHT]) {
    it(`${palette.name} is readable on VS Code's terminal background and on the selection tint`, () => {
      const surface = palette.canvas;
      const roles: Role[] = ['text', 'muted', 'accent', 'accent2', 'success', 'warn', 'error', 'info'];
      for (const role of roles) {
        assert.ok(contrast(palette.fg[role], surface) >= 4.5, `${role} on the background`);
        // The selected row keeps its colors on the tint.
        assert.ok(contrast(palette.fg[role], palette.selection) >= 4.5, `${role} on the selection tint`);
      }
      assert.ok(contrast(palette.fg.selText, palette.selection) >= 7, 'selected text');
      for (const role of ['text', 'muted', 'error'] as Role[]) {
        assert.ok(contrast(palette.fg[role], palette.danger) >= 4.5, `${role} on the delete tint`);
      }
      assert.ok(contrast(palette.fg.border, surface) >= 2, 'box borders are visible');
      assert.ok(contrast(palette.selection, surface) >= 1.1, 'the tint shows');
    });
  }

  it('falls back to 256 and 16 colors', () => {
    assert.equal(to256([0, 0, 0]), 16);
    assert.equal(to256([255, 255, 255]), 231);
    assert.equal(to256([128, 128, 128]), 244);
    assert.equal(to256([135, 95, 255]), 99);
    assert.equal(to16([250, 10, 10]), 9);
    assert.equal(to16([0, 0, 0]), 0);
    assert.equal(colorCode([167, 139, 250], 'truecolor', 'fg'), '38;2;167;139;250');
    assert.equal(colorCode([167, 139, 250], '256', 'bg'), `48;5;${to256([167, 139, 250])}`);
    assert.match(colorCode(DARK.selection, '16', 'bg'), /^(4[0-7]|10[0-7])$/);
    assert.match(colorCode(DARK.fg.error, '16', 'fg'), /^(3[0-7]|9[0-7])$/);
  });
});

describe('session colors', () => {
  it('recolors only the cursor and the ANSI colors of one terminal, and resets with 104 and 112', () => {
    const dark = sessionColorSequence(sessionColorsFor('dark'));
    assert.doesNotMatch(dark, /\x1b\]1[01];/, "the terminal's own background and text stay");
    assert.match(dark, /\x1b\]12;#f59ac8\x07/);
    assert.equal(dark.match(/\x1b\]4;\d+;#[0-9a-f]{6}\x07/g)?.length, 16);
    assert.match(sessionColorSequence(sessionColorsFor('light')), /\x1b\]12;#be185d\x07/);
    assert.equal(SESSION_COLOR_RESET, '\x1b]104\x07\x1b]112\x07');
  });

  for (const kind of ['dark', 'light'] as const) {
    it(`keeps ${kind} ANSI colors readable on VS Code's terminal background`, () => {
      const colors = sessionColorsFor(kind);
      const background = paletteFor(kind).canvas;
      // Red, green, yellow, blue, magenta, cyan and their bright versions, and white/black text.
      for (const index of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, kind === 'dark' ? 7 : 0]) {
        assert.ok(contrast(colors.ansi[index], background) >= 4.5, `ANSI ${index}`);
      }
    });
  }
});
