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

# fab nodes default to node 20; the project's pinned node lives in this
# cache on boxes already broken in by a prior gate. Carry-WHEN-CACHED, not
# provision: a clean node without the cache still refuses LOUDLY at the
# engines check below (correct — better than a silent node-20 run where
# four node:sqlite suites fail to RUN while the totals still print, which
# is how this line got here). Provisioning-on-miss is a deliberate later
# step, not an accident this comment pretends already happened.
PINNED_NODE="$HOME/.cache/playapal-node-v22.23.2/bin"
[ -d "$PINNED_NODE" ] && export PATH="$PINNED_NODE:$PATH"

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

# A SKIPPED SUITE IS NOT A PASSING SUITE, and nothing here used to say so:
# "Test Suites: 6 skipped, 104 passed" matches the passed grep, misses the
# failed grep, and prints GATE: PASS. Several suites describe.skip on a
# missing local corpus or a gitignored build dir, so a whole area can go
# dark — including a data-terms guard — while the number beside it looks
# healthy. Found 2026-08-25, after a night of quoting the passed count.
#
# The baseline is today's REAL number, not zero: those skips have honest
# reasons, and demanding zero would just get the check deleted. Raising it
# is allowed and must be argued for in the commit that raises it.
# 3 -> 2 on 2026-08-25: the art embargo guard pointed at a gitignored
# build dir and had never once run; repointed at the pack that ships, it
# joins the suite. A baseline only ever tightens by someone FIXING a
# skip, which is the direction this number should move.
GATE_SKIP_BASELINE="${GATE_SKIP_BASELINE:-2}"
skipped=$(sed -n 's/^Test Suites:.*[^0-9]\([0-9][0-9]*\) skipped.*/\1/p' /tmp/gate-jest.$$ | tail -1)
skipped="${skipped:-0}"
echo "gate: ${skipped} suite(s) skipped (baseline ${GATE_SKIP_BASELINE})"
if [ "$skipped" -gt "$GATE_SKIP_BASELINE" ]; then
  echo "gate: MORE SUITES SKIPPED (${skipped}) THAN THE BASELINE (${GATE_SKIP_BASELINE})." >&2
  echo 'gate: a suite that stopped running is not a suite that passed — find out which, and either fix it or raise the baseline deliberately.' >&2
  rm -f /tmp/gate-jest.$$
  exit 1
fi
rm -f /tmp/gate-jest.$$

if [ "${1:-}" = "--apk" ]; then
  echo '== apk (test-signed)'
  # The settings.gradle guard refuses local gradle so an ACCIDENTAL heavy
  # build cannot freeze the laptop. This one is deliberate — the repo's own
  # gate asked for it — so it carries the documented escape rather than
  # being blocked by a rule aimed at something else. On fab, FAB_ID is
  # already set and this changes nothing. (Found by the commit-truth audit:
  # the guard silently disabled this arm, and every gate that "passed" it
  # had run on fab.)
  (cd android && FAB_ALLOW_LOCAL_BUILD=1 ./gradlew assembleRelease -PallowDebugSigning=true)
  sha256sum android/app/build/outputs/apk/release/app-arm64-v8a-release.apk
fi
echo 'GATE: PASS'
