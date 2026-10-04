import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVariant, resolvePalette, VARIANTS } from './palettes';
import { contrast, DARK, LIGHT, sessionColorSequence, sessionColorsFor, surfaceOf, type Role } from './theme';

describe('palette variants under review', () => {
  it('keeps Easy SSH Dark and Light when no variant is picked', () => {
    assert.equal(resolvePalette('dark'), DARK);
    assert.equal(resolvePalette('light'), LIGHT);
    assert.equal(resolvePalette('light', 'C'), VARIANTS.C.light);
    assert.equal(parseVariant('D'), 'D');
    assert.equal(parseVariant(''), undefined);
    assert.equal(parseVariant('Z'), undefined);
  });

  for (const variant of Object.values(VARIANTS)) {
    for (const palette of [variant.dark, variant.light]) {
      it(`${variant.id} ${palette.kind} (${palette.name}) is readable`, () => {
        assert.equal(palette.kind, palette === variant.dark ? 'dark' : 'light');
        const surface = surfaceOf(palette);
        const roles: Role[] = ['text', 'muted', 'accent', 'accent2', 'success', 'warn', 'error', 'info'];
        for (const role of roles) assert.ok(contrast(palette.fg[role], surface) >= 4.5, `${role} on the background`);
        assert.ok(contrast(palette.fg.border, surface) >= 1.8, 'border is visible');
        const style = palette.selectStyle ?? 'bar';
        if (style === 'bar') {
          assert.ok(contrast(palette.fg.selText, palette.selection) >= 4.5, 'text on the bar');
          assert.ok(contrast(palette.fg.selMuted, palette.selection) >= 4.5, 'dim text on the bar');
          assert.ok(contrast(palette.fg.selText, palette.danger) >= 4.5, 'text on the delete bar');
        } else if (style === 'tint') {
          for (const role of [...roles, 'selText'] as Role[]) assert.ok(contrast(palette.fg[role], palette.selection) >= 4.5, `${role} on the tint`);
          for (const role of ['text', 'muted', 'error'] as Role[]) assert.ok(contrast(palette.fg[role], palette.danger) >= 4.5, `${role} on the delete tint`);
        } else {
          assert.ok(contrast(palette.fg.selText, surface) >= 4.5, 'bold selected text');
        }
      });
    }
  }

  it('leaves the terminal background alone in a session when the variant has no panel', () => {
    const neutral = sessionColorSequence(sessionColorsFor('dark', VARIANTS.A.dark));
    assert.doesNotMatch(neutral, /\x1b\]1[01];/);
    assert.match(neutral, /\x1b\]12;/);
    assert.match(sessionColorSequence(sessionColorsFor('dark', VARIANTS.C.dark)), /\x1b\]11;#25252a\x07/);
  });
});
