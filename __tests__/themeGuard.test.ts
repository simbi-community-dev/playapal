/**
 * THE THEME GUARD (owner ruling 2026-08-24): "make sure all the little
 * labels and stuff get both [modes] — even good long-standing apps like
 * iBurn have issues with that." A one-time sweep decays; this test is the
 * standing guard. It walks every source file and fails on any raw color
 * literal outside src/theme.ts — a hardcoded color is a label that
 * silently misses one of the two palettes. Deliberate exceptions live in
 * ALLOWLIST below, each with its file, its literal, and its reason; an
 * allowlist entry whose literal has since disappeared fails too, so the
 * list can never rot into a blanket pardon.
 *
 * Plus the unit contracts of the palette machinery itself: resolveScheme's
 * preference × OS matrix, applyPalette's in-place mutation and lossless
 * light→dark→light round-trip, and the persistence + never-throw reload
 * seams.
 */
import {
  activeScheme,
  appearancePref,
  applyPalette,
  colors,
  palettes,
  requestThemeReload,
  resolveScheme,
  setAppearancePref,
} from '../src/theme';

// This RN-only repo ships no node type definitions, so the guard's few
// node seams are declared minimally here instead of adding @types/node.
declare const __dirname: string;
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  readdirSync(dir: string, opts: { withFileTypes: true }): DirEntry[];
  readFileSync(file: string, encoding: 'utf8'): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  sep: string;
};

// The settings table, reduced to a Map (the tour.test pattern) — theme
// reaches it lazily via require, which resolves to this same mock.
const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

const SRC_ROOT = path.join(__dirname, '..', 'src');
// The ONE file allowed to say colors out loud.
const THEME_FILE = 'src/theme.ts';

/** A deliberately kept literal: path + literal + why it must not theme. */
interface AllowedLiteral {
  file: string;
  literal: string;
  reason: string;
}

const ALLOWLIST: AllowedLiteral[] = [
  {
    file: 'src/beam/BeamQr.tsx',
    literal: '#ffffff',
    reason:
      'QR quiet zone must stay white in both modes — scanner hardware contrast, not a theme choice',
  },
  {
    file: 'src/screens/FriendsSection.tsx',
    literal: '#ffffff',
    reason:
      'QR quiet zone must stay white in both modes — scanner hardware contrast, not a theme choice',
  },
  {
    file: 'src/crews/PodQr.tsx',
    literal: '#ffffff',
    reason:
      'QR quiet zone must stay white in both modes — scanner hardware contrast, not a theme choice',
  },
];

// Hex (#RGB through #RRGGBBAA) or a functional color constructor. The \b
// after the hex run keeps prose like "#playapal" from matching while still
// catching a literal mid-expression.
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function repoRelative(file: string): string {
  return path
    .relative(path.join(__dirname, '..'), file)
    .split(path.sep)
    .join('/');
}

interface Finding {
  file: string;
  line: number;
  literal: string;
}

function findColorLiterals(): Finding[] {
  const findings: Finding[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = repoRelative(file);
    if (rel === THEME_FILE) {
      continue; // the palette's home — the only legal place
    }
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text: string, i: number) => {
        for (const m of text.match(COLOR_LITERAL) ?? []) {
          findings.push({ file: rel, line: i + 1, literal: m });
        }
      });
  }
  return findings;
}

afterEach(() => {
  applyPalette('light');
  mockSettings.clear();
});

describe('the theme guard — no raw colors outside src/theme.ts', () => {
  const findings = findColorLiterals();

  it('every color literal in src/ is a theme token or an allowlisted exception', () => {
    const violations = findings.filter(
      f =>
        !ALLOWLIST.some(
          a =>
            a.file === f.file &&
            a.literal.toLowerCase() === f.literal.toLowerCase(),
        ),
    );
    // A failure here means a new label just went single-mode. Use a token
    // from src/theme.ts (adding one to BOTH palettes if none fits), or —
    // only for a genuine hardware/spec constant — add an ALLOWLIST entry
    // with its reason.
    expect(
      violations.map(v => `${v.file}:${v.line} ${v.literal}`),
    ).toEqual([]);
  });

  it('every allowlist entry is still live (no rotting pardons)', () => {
    for (const a of ALLOWLIST) {
      const live = findings.some(
        f =>
          f.file === a.file &&
          f.literal.toLowerCase() === a.literal.toLowerCase(),
      );
      expect(`${a.file} ${a.literal} live=${live}`).toBe(
        `${a.file} ${a.literal} live=true`,
      );
    }
  });
});

describe('resolveScheme — preference × OS matrix', () => {
  const osValues = ['dark', 'light', 'no-preference', null, undefined, 'huh'];

  it('an explicit preference always wins, whatever the OS says', () => {
    for (const os of osValues) {
      expect(resolveScheme('light', os)).toBe('light');
      expect(resolveScheme('dark', os)).toBe('dark');
    }
  });

  it("'system' follows the OS, and anything not exactly dark is light", () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    for (const os of osValues.filter(v => v !== 'dark')) {
      expect(resolveScheme('system', os)).toBe('light');
    }
  });
});

describe('applyPalette — in-place mutation, lossless round-trip', () => {
  it('starts light, with the exact original identity values', () => {
    expect(activeScheme()).toBe('light');
    expect(colors.dust).toBe('#EFE6D8');
    expect(colors.night).toBe('#3A2F28');
    // clay deepened 2026-08-24 (a11y review): 4.5:1+ as small text on every
    // light ground — the identity hue survives, the lightness moved.
    expect(colors.clay).toBe('#9F4B30');
  });

  it('both palettes carry exactly the same keys (mapInk included)', () => {
    expect(Object.keys(palettes.dark).sort()).toEqual(
      Object.keys(palettes.light).sort(),
    );
    expect(Object.keys(palettes.dark.mapInk).sort()).toEqual(
      Object.keys(palettes.light.mapInk).sort(),
    );
  });

  it('mutates the one shared object in place — identity survives, mapInk included', () => {
    const colorsRef = colors;
    const inkRef = colors.mapInk;
    applyPalette('dark');
    expect(colors).toBe(colorsRef);
    expect(colors.mapInk).toBe(inkRef);
    expect(activeScheme()).toBe('dark');
    expect(colors.dust).toBe(palettes.dark.dust);
    expect(colors.overlayScrim).toBe(palettes.dark.overlayScrim);
    expect(colors.mapInk.toilet).toBe(palettes.dark.mapInk.toilet);
    expect(colors.mapInk.youHalo).toBe(palettes.dark.mapInk.youHalo);
  });

  it('light→dark→light restores every value exactly', () => {
    const before = JSON.parse(JSON.stringify(colors));
    applyPalette('dark');
    expect(JSON.parse(JSON.stringify(colors))).not.toEqual(before);
    applyPalette('light');
    expect(JSON.parse(JSON.stringify(colors))).toEqual(before);
    expect(activeScheme()).toBe('light');
  });
});

describe('the preference seam', () => {
  it("defaults to 'system' when nothing is saved", () => {
    expect(appearancePref()).toBe('system');
  });

  it('setAppearancePref persists AND applies immediately', () => {
    setAppearancePref('dark');
    expect(mockSettings.get('appearance')).toBe('dark');
    expect(appearancePref()).toBe('dark');
    expect(colors.dust).toBe(palettes.dark.dust);
    // Back to system: the jest RN mock's OS scheme is not dark, so this
    // resolves light again — the write and the flip travel together.
    setAppearancePref('system');
    expect(appearancePref()).toBe('system');
    expect(colors.dust).toBe(palettes.light.dust);
  });

  it('a saved value that is not a mode reads as system', () => {
    mockSettings.set('appearance', 'chartreuse');
    expect(appearancePref()).toBe('system');
  });

  it('requestThemeReload resolves false — never throws — without the native module', async () => {
    await expect(requestThemeReload()).resolves.toBe(false);
  });

  it('requestThemeReload resolves true when the ThemeReload contract is present', async () => {
    const rn = require('react-native');
    rn.NativeModules.ThemeReload = { reload: jest.fn().mockResolvedValue(null) };
    try {
      await expect(requestThemeReload()).resolves.toBe(true);
      expect(rn.NativeModules.ThemeReload.reload).toHaveBeenCalledTimes(1);
    } finally {
      delete rn.NativeModules.ThemeReload;
    }
  });
});
