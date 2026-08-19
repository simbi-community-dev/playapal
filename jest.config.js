module.exports = {
  preset: '@react-native/jest-preset',
  // build/ holds the materialised public tree — a full copy of src and
  // __tests__. Without this ignore, jest runs every suite twice and keeps
  // stale copies alive after source fixes (same class as the eslint ignore).
  testPathIgnorePatterns: ['/node_modules/', '/build/', '/.claude/'],
};
