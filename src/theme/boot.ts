/**
 * Theme boot — MUST be index.js's FIRST import, before App and before any
 * component module. Every screen freezes its colors at import time via
 * module-level StyleSheet.create, so the palette has to be resolved and
 * applied HERE, before any of those modules evaluate. See the boot-order
 * note at the top of src/theme.ts. Future screens must never be imported
 * (directly or transitively) from index.js above this module — that is
 * the one way to ship a half-themed screen.
 */
import { Appearance as OsAppearance } from 'react-native';
import { appearancePref, applyPalette, resolveScheme } from '../theme';

// Appearance can be undefined in odd test environments, and getColorScheme
// can throw before the native side is fully up — a theme boot that can
// crash the app before its first frame is far worse than one wrong-mode
// frame, so every OS read is guarded.
function osScheme(): string | null | undefined {
  try {
    return OsAppearance?.getColorScheme?.();
  } catch {
    return null;
  }
}

// THE boot: saved preference × OS scheme, applied by mutating the shared
// colors object in place. After this line every StyleSheet.create in the
// app freezes the right palette.
applyPalette(resolveScheme(appearancePref(), osScheme()));

// OS scheme flips while the app runs (only meaningful when the preference
// is 'system'): reapply so anything reading colors.X inline at render
// follows along. Styles already frozen in mounted screens will NOT repaint
// — accepted and documented: the full repaint happens on the next JS
// reload or launch, when this module runs again.
try {
  OsAppearance?.addChangeListener?.(() => {
    if (appearancePref() === 'system') {
      applyPalette(resolveScheme('system', osScheme()));
    }
  });
} catch {
  // No live listener — the palette still resolves correctly every launch.
}
