import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  colorCode,
  contrast,
  DARK,
  editorThemeKind,
  hex,
  LIGHT,
  nextThemeChoice,
  paletteFor,
  parseColorDepth,
  parseThemeChoice,
  resolveThemeKind,
  SESSION_COLOR_RESET,
  sessionColorSequence,
  sessionColorsFor,
  themeLabel,
  to16,
  to256,
  type Role,
} from './theme';

describe('Easy SSH palettes', () => {
  it('follows VS Code in Auto and ignores it in Dark and Light', () => {
    assert.equal(resolveThemeKind('auto', 'light'), 'light');
    assert.equal(resolveThemeKind('auto', 'dark'), 'dark');
    assert.equal(resolveThemeKind('dark', 'light'), 'dark');
    assert.equal(resolveThemeKind('light', 'dark'), 'light');
    assert.equal(paletteFor('light'), LIGHT);
    assert.equal(paletteFor('dark'), DARK);
  });

  it('maps VS Code theme kinds: light and high-contrast light are light', () => {
    assert.equal(editorThemeKind(1), 'light');
    assert.equal(editorThemeKind(2), 'dark');
    assert.equal(editorThemeKind(3), 'dark');
    assert.equal(editorThemeKind(4), 'light');
  });

  it('cycles /theme Auto → Dark → Light → Auto and reads only known values', () => {
    assert.equal(nextThemeChoice('auto'), 'dark');
    assert.equal(nextThemeChoice('dark'), 'light');
    assert.equal(nextThemeChoice('light'), 'auto');
    assert.equal(parseThemeChoice('light'), 'light');
    assert.equal(parseThemeChoice('Light'), undefined);
    assert.equal(parseThemeChoice(3), undefined);
    assert.equal(parseColorDepth('256'), '256');
    assert.equal(parseColorDepth('16'), '16');
    assert.equal(parseColorDepth(undefined), 'truecolor');
    assert.equal(themeLabel('auto', 'light'), 'Auto (Easy SSH Light, follows VS Code)');
    assert.equal(themeLabel('dark', 'light'), 'Easy SSH Dark');
  });

  it('keeps the brand hues of the icon and the infographic', () => {
    assert.deepEqual(DARK.badgeFrom, hex('#8B5CF6'));
    assert.deepEqual(DARK.badgeTo, hex('#EC4899'));
    assert.deepEqual(DARK.fg.accent, hex('#A78BFA'));
    assert.deepEqual(LIGHT.fg.text, hex('#1E1B4B'));
    assert.deepEqual(LIGHT.panel, hex('#F5F3FF'));
  });

  for (const palette of [DARK, LIGHT]) {
    it(`${palette.name} has readable text on its panel and its selection bar`, () => {
      const onPanel: Role[] = ['text', 'muted', 'accent', 'accent2', 'success', 'warn', 'error', 'info'];
      for (const role of onPanel) {
        assert.ok(contrast(palette.fg[role], palette.panel) >= 4.5, `${role} on the panel`);
      }
      assert.ok(contrast(palette.fg.border, palette.panel) >= 3, 'border on the panel');
      assert.ok(contrast(palette.fg.selText, palette.selection) >= 4.5, 'text on the selection bar');
      assert.ok(contrast(palette.fg.selMuted, palette.selection) >= 4.5, 'dim text on the selection bar');
      assert.ok(contrast(palette.fg.selText, palette.danger) >= 4.5, 'text on the delete bar');
    });
  }

  it('reads on the terminal background outside the boxes (session hint)', () => {
    const vscodeDark = hex('#1F1F1F');
    const vscodeLight = hex('#FFFFFF');
    for (const role of ['text', 'muted', 'accent'] as const) {
      assert.ok(contrast(DARK.fg[role], vscodeDark) >= 4.5, `dark ${role}`);
      assert.ok(contrast(LIGHT.fg[role], vscodeLight) >= 4.5, `light ${role}`);
    }
  });

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
  it('recolors one terminal with OSC 10, 11, 12 and 4, and resets with 104, 110, 111, 112', () => {
    const dark = sessionColorSequence(sessionColorsFor('dark'));
    assert.match(dark, /\x1b\]11;#1b1740\x07/);
    assert.match(dark, /\x1b\]10;#f5f3ff\x07/);
    assert.match(dark, /\x1b\]12;#f9a8d4\x07/);
    assert.equal(dark.match(/\x1b\]4;\d+;#[0-9a-f]{6}\x07/g)?.length, 16);
    assert.match(sessionColorSequence(sessionColorsFor('light')), /\x1b\]11;#f5f3ff\x07/);
    assert.equal(SESSION_COLOR_RESET, '\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07');
  });

  for (const kind of ['dark', 'light'] as const) {
    it(`keeps ${kind} session text and ANSI colors readable`, () => {
      const colors = sessionColorsFor(kind);
      assert.ok(contrast(colors.foreground, colors.background) >= 7);
      // Red, green, yellow, blue, magenta, cyan and their bright versions.
      for (const index of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) {
        assert.ok(contrast(colors.ansi[index], colors.background) >= 4.5, `ANSI ${index}`);
      }
    });
  }
});
