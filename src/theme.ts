/**
 * Playa Pal visual identity: warm, dusty, sun-washed — in two grounds now,
 * light and dark. One flat token object, no design-system machinery.
 *
 * ── THE BOOT-ORDER TRICK (read before touching anything here) ──────────
 * Every screen freezes its colors at import time: module-level
 * StyleSheet.create({ color: colors.night, ... }) reads these values ONCE,
 * when the screen's module evaluates. So the palette must be resolved
 * BEFORE ANY COMPONENT MODULE EVALUATES. index.js imports
 * './src/theme/boot' as its FIRST import; boot resolves the saved
 * appearance preference + the OS scheme and calls applyPalette(), which
 * MUTATES the exported `colors` object in place. Only after that do
 * component modules load and freeze the (now correct) values.
 *
 * Consequences, in order of how much they will bite you:
 *   - `colors` is deliberately MUTABLE (no `as const`). Do not freeze it.
 *   - Never import a component module from index.js above the boot import,
 *     and never make this module itself depend on UI code.
 *   - Changing the preference at runtime cannot repaint styles that are
 *     already frozen; the real flip is a JS reload (requestThemeReload via
 *     the ThemeReload native module) so boot re-runs. When reload is not
 *     available, the honest fallback is "takes effect next time the app
 *     opens" — Settings shows exactly that.
 *   - This module has ZERO top-level imports on purpose: it is imported by
 *     every screen and by boot before anything else exists, so it must be
 *     loadable from anywhere, any time, with no side effects. The settings
 *     table and react-native are reached lazily inside functions.
 *
 * NEVER hardcode a color anywhere else in src/ — every literal outside
 * this file is a label that silently misses one of the two modes (the
 * iBurn bug class; owner ruling 2026-08-24). __tests__/themeGuard.test.ts
 * walks the whole tree and fails on any raw hex/rgba/hsl literal outside
 * this file, minus an explicit allowlist (QR quiet zones must stay white
 * for scanner hardware, so those are exempt BY NAME with reasons).
 */

/** The user's stated preference — 'system' follows the OS. */
export type Appearance = 'system' | 'light' | 'dark';

/** A concrete resolved scheme — what actually paints. */
export type ColorScheme = 'light' | 'dark';

// The daylight palette — the app's original identity, values verbatim.
const LIGHT = {
  // Ground
  dust: '#EFE6D8', // app background — pale playa dust
  sand: '#F7F1E6', // cards / assistant bubbles
  haze: '#E3D5C0', // borders, dividers, disabled

  // Ink
  night: '#3A2F28', // primary text — desert night brown
  // Secondary text. Darkened from #8A7A6A (a11y review 2026-08-24): the
  // old value read 3.35–3.87:1 on dust/sand/field — under WCAG AA 4.5:1
  // for the small hint/metadata text this token paints everywhere. Same
  // warm gray-brown hue, one step more ink: 4.84–5.60:1 on all grounds.
  faded: '#6F6152',
  cream: '#FBF7EF', // legacy light-on-accent — prefer onAccent for text
  // Text/icons ON accent fills (buttons, active chips, badges). Scheme-
  // specific by design (a11y review 2026-08-24): light accents are mid-dark
  // so near-white ink wins; DARK accents brighten a step, so near-white ink
  // collapsed to 1.97–3.83:1 there — the dark palette flips this token to
  // deep ink instead. Always pair accent fills with onAccent, never cream.
  onAccent: '#FBF7EF',

  // Accents. Every value here doubles as SMALL TEXT on dust/sand/field
  // somewhere (links, live rows, meta lines), so each must clear WCAG AA
  // 4.5:1 against field (#FBF7EF), the lightest ground — and, symmetrically,
  // carry onAccent text at 4.5:1 when used as a fill. Deepened for that
  // (a11y review 2026-08-24); hue families kept, only lightness moved.
  clay: '#9F4B30', // primary — sun-baked clay (was #B4593A at 3.83:1 on dust)
  clayDeep: '#93462E',
  sage: '#5F6B47', // event cards accent — dusty sage (was #7C8763, 3.09:1)
  gold: '#815E11', // status/highlight — golden hour (was #C99A3C, 2.08:1)
  plum: '#6E4A5E', // persona chip — dusk plum (already 6.06:1+, unchanged)

  // Surfaces & veils (the literal sweep lives on these — see themeGuard)
  field: '#FBF7EF', // input / chip surface — cream's value, but cream is
  // text-on-accent and STAYS light in dark mode, while a field must go
  // dark with the ground; two tokens, one light value, different fates.
  overlayScrim: 'rgba(58, 47, 40, 0.85)', // Tour / full-screen dusk scrim
  backdrop: 'rgba(58, 47, 40, 0.55)', // lighter modal / sheet backdrop
  pressHint: '#00000010', // PackReader's faint press tint

  // Map inks — the CityMap dots that are not shared UI chrome. Sub-object
  // so the map reads colors.mapInk.toilet and the guard test can insist
  // the whole set exists in both palettes.
  mapInk: {
    toilet: '#5f86a8', // the most load-bearing dots in the city
    art: '#c9a24b', // saved pins / art
    friend: '#b45a94', // friends' camps
    you: '#3d7dd8', // the you-dot
    youHalo: '#3d7dd8', // drawn under the you-dot at reduced opacity
  },
};

export type Palette = typeof LIGHT;

// The night palette — same warm, dusty personality, dark ground: ground
// goes deep warm near-black, ink flips to bone, accents brighten a step so
// they keep their contrast against the dark ground.
const DARK: Palette = {
  // Ground
  dust: '#16120E', // deep warm near-black — dust after dark
  sand: '#221C16', // raised card, still warm
  haze: '#3A3129', // borders/dividers — visible on both dust and sand

  // Ink
  night: '#ECE3D1', // primary text flips to bone
  faded: '#A5988A', // secondary text
  cream: '#FBF7EF', // legacy light-on-accent — prefer onAccent for text
  // Dark mode's accents are BRIGHT, so text on them must be dark: cream on
  // dark clay measured 3.14:1, on sage 2.58, on gold 1.97 (a11y review
  // 2026-08-24). Deep warm ink clears 5.3:1+ on every dark accent fill.
  onAccent: '#1C1610',

  // Accents (each one step brighter than its daylight self)
  clay: '#D4714C',
  clayDeep: '#E2825D', // "deep" flips lighter: emphasis on dark ground
  // needs MORE light, not more pigment
  sage: '#93A17A',
  gold: '#D9AC52',
  // Brightened from #9C7188 (a11y review 2026-08-24): as small badge text
  // on dark sand it read 4.12:1 — under AA. Same dusk-plum hue, one step
  // lighter: 5.69:1 on sand, and deep onAccent ink clears 6:1 on it as a
  // chip fill.
  plum: '#B18BA3',

  // Surfaces & veils
  field: '#2B241C', // input/chip surface — one step above sand
  overlayScrim: 'rgba(8, 6, 4, 0.88)', // deeper dusk over a dark app
  backdrop: 'rgba(8, 6, 4, 0.62)',
  pressHint: '#FFFFFF12', // press tint flips to a faint lightening

  // Map inks brightened for the dark map ground
  mapInk: {
    toilet: '#7FA9CB',
    art: '#E3BC66',
    friend: '#D583B4',
    you: '#6FA7F2',
    youHalo: '#6FA7F2',
  },
};

/** Both palettes by scheme — exported for tests and future tooling. */
export const palettes: Record<ColorScheme, Palette> = {
  light: LIGHT,
  dark: DARK,
};

/**
 * THE live token object. Mutable BY DESIGN (see the boot-order note in the
 * header): boot resolves the scheme and applyPalette() rewrites these
 * values in place before any StyleSheet.create can freeze them. Starts as
 * a copy of LIGHT (never the LIGHT object itself — mutating the master
 * palette would make the light↔dark round-trip lossy).
 */
export const colors: Palette = { ...LIGHT, mapInk: { ...LIGHT.mapInk } };

let currentScheme: ColorScheme = 'light';

/**
 * Rewrite `colors` in place to the given scheme. In place, not by
 * reassignment: every module holds a reference to the SAME object (and to
 * the same nested mapInk object), so identity must survive the swap.
 */
export function applyPalette(scheme: ColorScheme): void {
  const { mapInk, ...flat } = palettes[scheme];
  Object.assign(colors, flat);
  Object.assign(colors.mapInk, mapInk);
  currentScheme = scheme;
}

/** The scheme the palette currently painted with (what boot resolved, or
 * what the last applyPalette set). */
export function activeScheme(): ColorScheme {
  return currentScheme;
}

/**
 * Pure preference × OS-scheme resolution — exported for tests. Anything
 * that is not exactly 'dark' from the OS ('light', 'no-preference', null,
 * undefined, garbage) resolves light: light is the app's native identity
 * and the safe default.
 */
export function resolveScheme(
  pref: Appearance,
  osScheme: string | null | undefined,
): ColorScheme {
  if (pref === 'light' || pref === 'dark') {
    return pref;
  }
  return osScheme === 'dark' ? 'dark' : 'light';
}

const APPEARANCE_SETTING_KEY = 'appearance';

// The settings table, reached lazily so this module stays import-safe from
// anywhere (boot runs before almost everything; tests mock the db module
// registry-wide and the require() below resolves to that same mock).
function settingsDb(): typeof import('./events/db') {
  return require('./events/db') as typeof import('./events/db');
}

/** The saved preference; 'system' when unset, unreadable, or nonsense. */
export function appearancePref(): Appearance {
  try {
    const v = settingsDb().getSetting(APPEARANCE_SETTING_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system'; // a db that cannot open must never break theming
  }
}

/**
 * Persist the preference AND apply the resolved palette immediately.
 * Styles frozen in already-imported modules will not repaint until the JS
 * reload — but anything reading colors.X inline at render flips right now,
 * so the choice is never a completely silent write.
 */
export function setAppearancePref(pref: Appearance): void {
  try {
    settingsDb().setSetting(APPEARANCE_SETTING_KEY, pref);
  } catch {
    // Not persisted — the palette below still flips for this session.
  }
  let osScheme: string | null | undefined;
  try {
    const rn = require('react-native') as typeof import('react-native');
    osScheme = rn.Appearance?.getColorScheme?.();
  } catch {
    osScheme = null;
  }
  applyPalette(resolveScheme(pref, osScheme));
}

/** The native module behind the live flip, or null on a build without it.
 * Reached lazily like everything else here (the zero-top-level-imports rule
 * in the header). */
function themeReloadModule(): { reload: () => Promise<unknown> } | null {
  try {
    const rn = require('react-native') as typeof import('react-native');
    const mod = rn.NativeModules?.ThemeReload;
    return mod && typeof mod.reload === 'function' ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Will picking an appearance actually restart the JS surface on this build?
 *
 * THE SAME PROBE, WITHOUT PULLING THE TRIGGER — so a screen can warn about
 * the consequences of the tap BEFORE offering it. That matters because the
 * consequences are not confined to color: the reload tears down the JS
 * context, and everything the mesh holds in module memory goes with it (the
 * live sharing session in src/crews/session.ts is one object in one
 * variable; the native side stops the radio and the foreground service in
 * CrewBeaconModule.invalidate()). Measured on two phones (field sweep X2):
 * changing Appearance under a live share left the switch unchecked and the
 * pod unable to see the camper, with nothing said about it either way.
 *
 * It has to be asked in advance, not after: ThemeReload.reload() resolves
 * its promise FIRST and then tears the context down, so there is no
 * reliable "after" in which to tell anyone anything.
 *
 * False on a build without the module — where nothing restarts, the picked
 * mode lands next launch, and a warning about ending a session would be a
 * lie in the other direction.
 */
export function themeReloadAvailable(): boolean {
  return themeReloadModule() !== null;
}

/**
 * Ask the native side to reload the JS bundle so boot re-runs and every
 * StyleSheet freezes the new palette. Contract with the parallel native
 * lane: NativeModules.ThemeReload.reload() is a promise-resolving method.
 * Resolves true when the reload was accepted, false — NEVER throws — when
 * the module is absent or fails; the caller shows the "takes effect next
 * time the app opens" copy on false.
 */
export async function requestThemeReload(): Promise<boolean> {
  const mod = themeReloadModule();
  if (!mod) {
    return false;
  }
  try {
    await mod.reload();
    return true;
  } catch {
    return false;
  }
}

/**
 * The minimum touch target (a11y review 2026-08-24): every tappable chip,
 * row, and button meets 44×44pt — Apple HIG's floor, and the practical one
 * for gloved, dusty, headlamp-lit hands. Spread `...tap` into a pressable
 * style (with centering where the content could float) instead of scattering
 * per-site magic numbers.
 */
export const tap = {
  minHeight: 44,
  minWidth: 44,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  bubble: 16,
  card: 12,
  chip: 999,
} as const;

export const type = {
  body: 16,
  small: 13,
  tiny: 11,
  title: 20,
  /**
   * A glyph that IS the control — a transport ▶/■ on a button, not a
   * symbol sitting inside a line of text. One step above title on purpose
   * (owner report, 2026-08-26: "the play button is tiny on received
   * voicenotes"): `tap` answers where a gloved thumb can LAND, and this
   * answers whether a sun-blind eye can FIND it from arm's length. Use it
   * only where the glyph carries the whole affordance.
   */
  glyph: 28,
} as const;

/**
 * TEXT SIZE — the reading-glasses dial (owner ask 2026-08-26: "settings
 * needs a font size +/- option"). Sun-blind eyes and glasses left in the
 * tent are the normal state out there, not the edge case.
 *
 * WHY THIS IS NOT A MULTIPLIER ON `type` ABOVE. Every screen freezes its
 * sizes the same way it freezes its colors — module-level
 * StyleSheet.create reads type.body ONCE — so scaling these four numbers
 * could only land on the next JS reload, which is exactly the restart the
 * appearance rows have to warn campers about. A size dial that costs a
 * restart is a dial nobody turns twice. So the scale lives HERE as one
 * number with a change signal, and src/components/Text.tsx multiplies it
 * into every Text at RENDER time: tap the stepper, the whole app grows
 * before your thumb leaves the glass.
 *
 * The steps are named, not free-floating. A slider invites a camper to
 * land on 1.03× in the dust; four rungs cannot be missed with gloves on,
 * and the ceiling is chosen so no screen explodes (spot-checked at 1.4×
 * on the pod card, the event lists, and this screen itself).
 */
/** Scroll slack, in points, for "am I still pinned to newest". Momentum and
 * rounding leave slack, and a list that refuses to re-pin two points short
 * reads as broken. Shared by every auto-scrolling list so they cannot
 * disagree about what "at the bottom" means. */
export const PIN_SLACK_PT = 24;

export const TEXT_SCALES = [0.85, 1, 1.2, 1.4] as const;

/** What each rung is called out loud — index-aligned with TEXT_SCALES. */
export const TEXT_SCALE_LABELS = [
  'Smaller',
  'Default',
  'Bigger',
  'Biggest',
] as const;

const TEXT_SCALE_SETTING_KEY = 'textScale';

/** The live scale. 1 until loadTextScale() reads the saved rung at boot. */
let currentTextScale: number = 1;

/** Everything currently rendering text (see src/components/Text.tsx). */
const textScaleListeners = new Set<() => void>();

/**
 * Snap any value onto a real rung. Garbage, NaN, and out-of-range all land
 * somewhere sane: nearest rung wins, so 3 clamps to the 1.4 ceiling and
 * 0.1 to the 0.85 floor, and anything unreadable falls to 1. Every entry
 * into the scale goes through here — the saved setting, the stepper, and
 * whatever a future caller passes.
 */
export function clampTextScale(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !isFinite(n)) {
    return 1;
  }
  let best: number = TEXT_SCALES[1];
  for (const step of TEXT_SCALES) {
    if (Math.abs(step - n) < Math.abs(best - n)) {
      best = step;
    }
  }
  return best;
}

/** The rung one step up (+1) or down (−1), stopping at the ends. */
export function nextTextScale(current: number, delta: number): number {
  const rungs: readonly number[] = TEXT_SCALES;
  const here = rungs.indexOf(clampTextScale(current));
  const there = Math.min(
    TEXT_SCALES.length - 1,
    Math.max(0, here + (delta > 0 ? 1 : -1)),
  );
  return TEXT_SCALES[there];
}

/** What this rung is called ('Default', 'Bigger', …). */
export function textScaleLabel(value: number): string {
  const rungs: readonly number[] = TEXT_SCALES;
  const i = rungs.indexOf(clampTextScale(value));
  return TEXT_SCALE_LABELS[i < 0 ? 1 : i];
}

/** The multiplier every Text is rendering with right now. */
export function textScale(): number {
  return currentTextScale;
}

/**
 * Read the saved rung. Called once from src/theme/boot.ts, beside the
 * palette — same reason, same moment, one honest launch-time read instead
 * of a lazy first-touch that would depend on which screen mounts first.
 */
export function loadTextScale(): void {
  try {
    currentTextScale = clampTextScale(
      settingsDb().getSetting(TEXT_SCALE_SETTING_KEY),
    );
  } catch {
    currentTextScale = 1; // a db that cannot open must never shrink the app
  }
}

/**
 * Subscribe to size changes — the useSyncExternalStore half of the live
 * flip. Returns its own unsubscribe.
 */
export function subscribeTextScale(listener: () => void): () => void {
  textScaleListeners.add(listener);
  return () => {
    textScaleListeners.delete(listener);
  };
}

/**
 * Persist a rung and repaint at it immediately. Order matters: the live
 * value moves BEFORE the listeners fire, and a db that refuses the write
 * still leaves the app at the size the camper just asked for — the size
 * they can read beats the size we could save.
 */
export function setTextScale(value: number): void {
  const next = clampTextScale(value);
  currentTextScale = next;
  try {
    settingsDb().setSetting(TEXT_SCALE_SETTING_KEY, String(next));
  } catch {
    // Not persisted — this session still grows; next launch starts over.
  }
  for (const listener of textScaleListeners) {
    listener();
  }
}
