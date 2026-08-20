#!/usr/bin/env bash
# The build/test runner. With no configuration every verb runs LOCALLY:
#
#   tools/runner.sh gate               # tools/gate.sh
#   tools/runner.sh apk                # tools/gate.sh --apk
#   tools/runner.sh install [serial…]  # adb install the built APK
#
# A repo-root `.runner.conf` (bash, sourced if present — intentionally not
# shipped in this tree) can override any verb by defining runner_gate,
# runner_apk, runner_install or runner_ios functions that dispatch to your
# own build infrastructure. The contract each override keeps:
#   - gate/apk exit nonzero on any failure (no green-looking tails);
#   - apk ends with a `sha256sum <apk>` line, and any artifact copied
#     across machines is verified against it before use.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .runner.conf ] && . .runner.conf

has() { declare -f "$1" >/dev/null; }

case "${1:-}" in
  gate)
    if has runner_gate; then runner_gate; else bash tools/gate.sh; fi
    ;;
  apk)
    if has runner_apk; then runner_apk; else bash tools/gate.sh --apk; fi
    ;;
  install)
    shift
    if has runner_install; then runner_install "$@"; else
      apk=android/app/build/outputs/apk/release/app-release.apk
      [ -f "$apk" ] || { echo 'runner: no APK; run `tools/runner.sh apk` first' >&2; exit 1; }
      for s in "${@:-$(adb devices | awk 'NR>1 && $2=="device"{print $1}')}"; do
        adb -s "$s" install -r "$apk" && echo "runner: installed on $s"
      done
    fi
    ;;
  ios)
    if has runner_ios; then runner_ios; else
      echo 'runner: no local iOS lane configured (see README "Run on iOS")' >&2
      exit 1
    fi
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
