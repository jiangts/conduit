#!/usr/bin/env bash
set -euo pipefail

attempt_output="${CONDUIT_ATTEMPT_OUTPUT:?CONDUIT_ATTEMPT_OUTPUT is required}"

if grep -R -q --binary-files=without-match 'DONE' "$attempt_output"; then
  exit 0
fi

echo "Ralph check failed: DONE not found in attempt output." >&2
exit 1
