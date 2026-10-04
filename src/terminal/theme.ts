/**
 * Easy SSH palettes for the screens drawn in the terminal (home, wizards, prompts).
 * Hues come from the icon and the README infographic: violet #8B5CF6 / #7C3AED,
 * lilac #B39DFA, pink #EC4899 / #F59AC8. The screens use the terminal's own
 * background; only the brand mark, accents and selection carry the colors.
 */

/** What the user picked: follow VS Code, or a fixed palette. */
export type ThemeChoice = 'auto' | 'dark' | 'light';
/** The palette actually drawn. */
export type ThemeKind = 'dark' | 'light';
/** How many colors the terminal shows. VS Code's terminal has truecolor. */
export type ColorDepth = 'truecolor' | '256' | '16';

export type Role =
  /** Body text. */
  | 'text'
  /** Help lines, column headers, secondary values. */
  | 'muted'
  /** Brand mark, prompt, step headers, focus. */
  | 'accent'
  /** Second brand hue (pink): the wordmark's "SSH", progress, keys in hints. */
  | 'accent2'
  /** Box borders. */
  | 'border'
  | 'success'
  | 'warn'
  | 'error'
  /** Agent sign-in, host keys, info notices. */
  | 'info'
  /** Plain text on the selected row's tint. */
  | 'selText';

export type Rgb = readonly [number, number, number];

export interface Palette {
  kind: ThemeKind;
  /** Display name, e.g. "Easy SSH Dark". */
  name: string;
  fg: Record<Role, Rgb>;
  /** Background inside the Easy SSH boxes. Unset: the terminal's own background. */
  panel?: Rgb;
  /** The background the colors were picked for when there is no panel (VS Code's default). */
  canvas: Rgb;
  /** The selected row's full-width tint. Rows keep their colors on it. */
  selection: Rgb;
  /** The tint of a selected destructive choice (Yes, delete). */
  danger: Rgb;
  /** The brand badge runs from this color to accent2's hue. */
  badgeFrom: Rgb;
  badgeTo: Rgb;
}

export function hex(value: string): Rgb {
  const clean = value.replace('#', '');
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

/**
 * Easy SSH Dark: no painted panel, so the screens sit on VS Code's own terminal
 * background. Purple and pink only for the brand mark, accents and a soft
 * selected-row tint. Colors are checked against VS Code's default dark
 * terminal background (#1F1F1F).
 */
export const DARK: Palette = {
  kind: 'dark',
  name: 'Easy SSH Dark',
  canvas: hex('#1F1F1F'),
  fg: {
    text: hex('#E6E6EA'),
    muted: hex('#9E9AAE'),
    accent: hex('#B39DFA'),
    accent2: hex('#F59AC8'),
    border: hex('#57506E'),
    success: hex('#86D99B'),
    warn: hex('#E9C46A'),
    error: hex('#F59393'),
    info: hex('#6FD3E3'),
    selText: hex('#FFFFFF'),
  },
  selection: hex('#2F2A42'),
  danger: hex('#4A2026'),
  badgeFrom: hex('#8B5CF6'),
  badgeTo: hex('#EC4899'),
};

/** Easy SSH Light: the same approach on VS Code's default light background (#FFFFFF). */
export const LIGHT: Palette = {
  kind: 'light',
  name: 'Easy SSH Light',
  canvas: hex('#FFFFFF'),
  fg: {
    text: hex('#1F2328'),
    muted: hex('#5E5A6E'),
    accent: hex('#6D28D9'),
    accent2: hex('#BE185D'),
    border: hex('#B9A7EE'),
    success: hex('#1A6B35'),
    warn: hex('#8A4B00'),
    error: hex('#B91C1C'),
    info: hex('#155E75'),
    selText: hex('#1E1B4B'),
  },
  selection: hex('#EEE9FB'),
  danger: hex('#FDE4E4'),
  badgeFrom: hex('#7C3AED'),
  badgeTo: hex('#DB2777'),
};

export function parseThemeChoice(value: unknown): ThemeChoice | undefined {
  return value === 'auto' || value === 'dark' || value === 'light' ? value : undefined;
}

export function parseColorDepth(value: unknown): ColorDepth {
  return value === '256' || value === '16' ? value : 'truecolor';
}

/** /theme cycles Auto → Dark → Light → Auto. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  if (choice === 'auto') return 'dark';
  if (choice === 'dark') return 'light';
  return 'auto';
}

/** The palette kind for a choice. Auto follows VS Code: light and high-contrast light themes get Light. */
export function resolveThemeKind(choice: ThemeChoice, editorKind: ThemeKind): ThemeKind {
  return choice === 'auto' ? editorKind : choice;
}

export function paletteFor(kind: ThemeKind): Palette {
  return kind === 'light' ? LIGHT : DARK;
}

/**
 * The palette to draw for a kind on VS Code's current theme. The palettes use
 * the terminal's own background; when /theme picks the other kind (Light on a
 * dark VS Code theme), the boxes and the session get that palette's background
 * so the text stays readable.
 */
export function paletteOn(kind: ThemeKind, editorKind: ThemeKind): Palette {
  const palette = paletteFor(kind);
  return kind === editorKind ? palette : { ...palette, panel: palette.canvas };
}

/** "Auto (Easy SSH Light)", "Easy SSH Dark". */
export function themeLabel(choice: ThemeChoice, editorKind: ThemeKind): string {
  const palette = paletteFor(resolveThemeKind(choice, editorKind));
  return choice === 'auto' ? `Auto (${palette.name}, follows VS Code)` : palette.name;
}

/** VS Code ColorThemeKind: 1 Light, 2 Dark, 3 HighContrast, 4 HighContrastLight. */
export function editorThemeKind(colorThemeKind: number): ThemeKind {
  return colorThemeKind === 1 || colorThemeKind === 4 ? 'light' : 'dark';
}

// ---- color depth fallbacks ----

const CUBE = [0, 95, 135, 175, 215, 255];

function distance(a: Rgb, b: Rgb): number {
  // Weighted RGB distance, close enough to perceived difference for picking a palette slot.
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/** The xterm-256 index (16-255) nearest to a color. */
export function to256(rgb: Rgb): number {
  const level = (value: number) => {
    let best = 0;
    for (let index = 1; index < CUBE.length; index += 1) {
      if (Math.abs(CUBE[index] - value) < Math.abs(CUBE[best] - value)) best = index;
    }
    return best;
  };
  const [r, g, b] = [level(rgb[0]), level(rgb[1]), level(rgb[2])];
  const cube = 16 + 36 * r + 6 * g + b;
  const cubeRgb: Rgb = [CUBE[r], CUBE[g], CUBE[b]];
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const grayIndex = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const grayValue = 8 + grayIndex * 10;
  const gray = 232 + grayIndex;
  return distance(rgb, [grayValue, grayValue, grayValue]) < distance(rgb, cubeRgb) ? gray : cube;
}

/** The standard 16 ANSI colors as xterm draws them by default. */
const ANSI16: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** The ANSI-16 index (0-15) nearest to a color. */
export function to16(rgb: Rgb): number {
  let best = 0;
  for (let index = 1; index < ANSI16.length; index += 1) {
    if (distance(rgb, ANSI16[index]) < distance(rgb, ANSI16[best])) best = index;
  }
  return best;
}

/** SGR parameters for a foreground or background color at a depth, e.g. "38;2;167;139;250". */
export function colorCode(rgb: Rgb, depth: ColorDepth, layer: 'fg' | 'bg'): string {
  if (depth === 'truecolor') return `${layer === 'fg' ? 38 : 48};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (depth === '256') return `${layer === 'fg' ? 38 : 48};5;${to256(rgb)}`;
  const index = to16(rgb);
  const base = layer === 'fg' ? (index < 8 ? 30 : 90) : index < 8 ? 40 : 100;
  return String(base + (index % 8));
}

/** A color between two others, t in [0, 1]. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** What render needs to paint: the palette and how many colors to use. */
export interface PaintTheme {
  palette: Palette;
  depth: ColorDepth;
}

export const DEFAULT_THEME: PaintTheme = { palette: DARK, depth: 'truecolor' };

// ---- connected shell sessions ----

export interface SessionColors {
  /** Unset: keep the terminal's own background and text color. */
  background?: Rgb;
  foreground?: Rgb;
  cursor: Rgb;
  /** ANSI 0-15: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones. */
  ansi: Rgb[];
}

/**
 * ANSI colors for connected shells, tuned for VS Code's default terminal
 * backgrounds. The background and text color stay the terminal's own.
 */
const DARK_ANSI: Rgb[] = [
  '#3A3550', '#F87171', '#86D99B', '#E9C46A', '#8AB4FF', '#D68CF5', '#6FD3E3', '#E6E6EA',
  '#8E89A3', '#FCA5A5', '#BBF7D0', '#FDE68A', '#A5B4FC', '#F59AC8', '#A5F3FC', '#FFFFFF',
].map(hex);

const LIGHT_ANSI: Rgb[] = [
  '#1F2328', '#B91C1C', '#1A6B35', '#8A4B00', '#1D4ED8', '#A21CAF', '#155E75', '#5E5A6E',
  '#6B6680', '#C81E1E', '#15803D', '#92400E', '#4F46E5', '#BE185D', '#0E7490', '#3B3663',
].map(hex);

/** Colors for a connected shell: the palette's pink cursor and its ANSI colors. */
export function sessionColorsFor(kind: ThemeKind, palette: Palette = paletteFor(kind)): SessionColors {
  return {
    background: palette.panel,
    foreground: palette.panel ? palette.fg.text : undefined,
    cursor: palette.fg.accent2,
    ansi: kind === 'light' ? LIGHT_ANSI : DARK_ANSI,
  };
}

export function oscColor(rgb: Rgb): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * xterm control sequences that recolor one terminal: OSC 10 (text), 11
 * (background), 12 (cursor) and 4 (the ANSI palette). VS Code's terminal applies
 * them to that terminal only; other terminals and the settings do not change.
 */
export function sessionColorSequence(colors: SessionColors): string {
  let out = '';
  if (colors.foreground) out += `\x1b]10;${oscColor(colors.foreground)}\x07`;
  if (colors.background) out += `\x1b]11;${oscColor(colors.background)}\x07`;
  out += `\x1b]12;${oscColor(colors.cursor)}\x07`;
  colors.ansi.forEach((rgb, index) => {
    out += `\x1b]4;${index};${oscColor(rgb)}\x07`;
  });
  return out;
}

/** OSC 104, 110, 111, 112: back to the terminal theme's palette, text, background and cursor. */
export const SESSION_COLOR_RESET = '\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07';
