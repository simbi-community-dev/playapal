/**
 * Playa Pal visual identity: warm, dusty, sun-washed. One flat token
 * object, no design-system machinery.
 */

export const colors = {
  // Ground
  dust: '#EFE6D8', // app background — pale playa dust
  sand: '#F7F1E6', // cards / assistant bubbles
  haze: '#E3D5C0', // borders, dividers, disabled

  // Ink
  night: '#3A2F28', // primary text — desert night brown
  faded: '#8A7A6A', // secondary text
  cream: '#FBF7EF', // text on clay

  // Accents
  clay: '#B4593A', // primary — sun-baked clay (user bubble, send button)
  clayDeep: '#93462E',
  sage: '#7C8763', // event cards accent — dusty sage
  gold: '#C99A3C', // status/highlight — golden hour
  plum: '#6E4A5E', // persona chip — dusk plum
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
} as const;
