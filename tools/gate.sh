#!/usr/bin/env bash
# The verification gate — one honest command for humans, CI, and agents.
#
#   bash tools/gate.sh          # lint + typecheck + full test suite
#   bash tools/gate.sh --apk    # …then build the on-device test APK and
#                               # print its SHA-256 (debug-signed; see the
#                               # README's Android release warning)
#
# Design rules this script exists to enforce (each learned the hard way):
#   - set -euo pipefail everywhere: a pipeline must never report its tail's
#     exit status instead of the failing stage's.
#   - The "Test Suites:" summary line is always printed. A tail window that
#     hides it once reported a suite-failure run as green.
#   - Node must satisfy engines (>=22.23): older node ships a node:sqlite
#     without FTS5 and several suites "fail to run" — which jest reports in
#     the SUITES line, not the tests line.
#   - The APK's SHA-256 is printed by the build itself, so any copy fetched
#     from a remote builder can be checksum-verified before install.
set -euo pipefail
cd "$(dirname "$0")/.."

node - <<'EOF'
const [maj, min] = process.versions.node.split('.').map(Number);
const ok = (maj === 22 && min >= 23) || maj === 24 || maj >= 26;
if (!ok) {
  console.error(`node ${process.versions.node} does not satisfy engines; ` +
    'use 22.23+ / 24.3+ (see README Requirements)');
  process.exit(1);
}
console.log(`node ${process.versions.node} ok`);
EOF

echo '== lint'
npx eslint .
echo '== typecheck'
npx tsc --noEmit
echo '== tests'
npx jest 2>&1 | tee /tmp/gate-jest.$$
grep -E 'Test Suites: .*[0-9]+ passed' /tmp/gate-jest.$$ >/dev/null || {
  echo 'gate: could not confirm the Test Suites summary line' >&2
  rm -f /tmp/gate-jest.$$
  exit 1
}
if grep -E 'Test Suites: .*failed' /tmp/gate-jest.$$ >/dev/null; then
  echo 'gate: one or more suites FAILED (see above)' >&2
  rm -f /tmp/gate-jest.$$
  exit 1
fi
rm -f /tmp/gate-jest.$$

if [ "${1:-}" = "--apk" ]; then
  echo '== apk (test-signed)'
  (cd android && ./gradlew assembleRelease -PallowDebugSigning=true)
  sha256sum android/app/build/outputs/apk/release/app-arm64-v8a-release.apk
fi
echo 'GATE: PASS'
