module.exports = {
  // build/ holds the materialised public tree — a COPY of src at build time.
  // Linting it double-reports every finding and keeps stale errors alive
  // after the source is fixed (public-QA P1, 2026-08-19).
  ignorePatterns: ['build/'],
  root: true,
  extends: '@react-native',
};
