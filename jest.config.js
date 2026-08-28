const fs = require('fs');
const path = require('path');

const FAB_GUARD = path.join(__dirname, 'tools', 'jest-fab-guard.js');

module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-gesture-handler|react-native-svg|react-native-image-picker)/)',
  ],
  // build/ holds the materialised public tree — a full copy of src and
  // __tests__. Without this ignore, jest runs every suite twice and keeps
  // stale copies alive after source fixes (same class as the eslint ignore).
  testPathIgnorePatterns: ['/node_modules/', '/build/', '/.claude/'],
  // ...and the haste map needs the same fence: testPathIgnorePatterns stops
  // SUITES under build/ from running, but the module map still indexes the
  // public tree's copy of every mock, and jest-haste-map warns "duplicate
  // manual mock found: react-native-qrcode-svg" on every run. A warning on
  // every green run is how real warnings die of neglect.
  modulePathIgnorePatterns: ['<rootDir>/build/'],
  // The QR view is stubbed, not transformed: react-native-qrcode-svg is ESM
  // over react-native-svg, whose commonjs build requires
  // @react-native/assets-registry — a package this tree does not install. So
  // transforming it swaps a syntax error for a resolution error. No suite
  // asserts QR pixels; they assert the link handed in, which a stub carries.
  moduleNameMapper: {
    '^react-native-qrcode-svg$': '<rootDir>/__mocks__/react-native-qrcode-svg.js',
    // react-native-webrtc THROWS at require time without its native half
    // (which is every jest run), so suites get the manual mock instead.
    '^react-native-webrtc$': '<rootDir>/__mocks__/react-native-webrtc.js',
  },
  // Heavy tests run on fab -- the jest half of the directive the gradle half
  // already enforces (android/settings.gradle), keyed on the same env. The
  // guard refuses a PARALLEL local run on the owner's fleet and routes it to
  // the builder instead.
  //
  // WIRED ONLY IF PRESENT, and that is not defensiveness. The guard is a
  // FLEET tool -- it names fab and an internal build policy -- so it is
  // private (-tools/jest-fab-guard.js in tools/PUBLIC-TREE.manifest), the
  // same call the manifest already makes for playapal-flip-verify.sh. A
  // public checkout therefore does not have this file, and a globalSetup
  // pointing at a missing module makes jest fail to START rather than fail a
  // test: `npm test`, the command CONTRIBUTING.md tells contributors is the
  // bar for a PR, would break on clone for everyone outside this house.
  ...(fs.existsSync(FAB_GUARD) ? { globalSetup: FAB_GUARD } : {}),
  setupFiles: ['react-native-gesture-handler/jestSetup'],
};
