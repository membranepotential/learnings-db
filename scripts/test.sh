#!/usr/bin/env bash
# Run the learnings/ test suite via node's built-in test runner. No deps.
#   ./scripts/test.sh             # all *.test.mjs under tests/
#   ./scripts/test.sh path/...    # explicit files
#
# `node --test <dir>` only auto-discovers in Node >= 21; we glob for `.test.mjs`
# so the script works on Node 20.x too.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -gt 0 ]]; then
	exec node --test "$@"
fi
shopt -s globstar nullglob
files=(tests/**/*.test.mjs)
if [[ ${#files[@]} -eq 0 ]]; then
	echo "no *.test.mjs files found under tests/" >&2
	exit 1
fi
exec node --test "${files[@]}"
