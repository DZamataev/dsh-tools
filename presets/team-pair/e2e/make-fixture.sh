#!/usr/bin/env bash
# Create the throwaway git repo the pair e2e run works on: a small ESM module
# whose `range(start, end)` is documented as inclusive but stops one short, plus
# a `node --test` file that fails because of it.
#
# Usage: make-fixture.sh [dir]     (default /tmp/team-pair-fixture; must be under /tmp)
set -euo pipefail

DIR="${1:-/tmp/team-pair-fixture}"
case "$DIR" in
  /tmp/*|/private/tmp/*|/var/folders/*) ;;
  *) echo "make-fixture: refusing to (re)create $DIR; it must be under /tmp" >&2; exit 2 ;;
esac
if [ "$DIR" = "/tmp" ] || [ "$DIR" = "/tmp/" ]; then
  echo "make-fixture: refusing to use /tmp itself" >&2; exit 2
fi

rm -rf -- "${DIR:?}"
mkdir -p "$DIR/src" "$DIR/test"
cd "$DIR"

cat > package.json <<'EOF'
{
  "name": "team-pair-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
EOF

cat > src/range.js <<'EOF'
/**
 * Build an inclusive integer range.
 *
 * `range(2, 5)` returns `[2, 3, 4, 5]`; `range(3, 3)` returns `[3]`.
 * With `step`, values advance by `step` and the last value never passes `end`:
 * `range(0, 10, 5)` returns `[0, 5, 10]`. When `start > end` the result is empty.
 *
 * @param {number} start - first value.
 * @param {number} end - last value, included when the step lands on it.
 * @param {number} [step=1] - positive increment.
 * @returns {number[]} the values from `start` to `end`.
 */
export function range(start, end, step = 1) {
  if (!(step > 0)) throw new RangeError('step must be positive')
  const values = []
  for (let value = start; value < end; value += step) {
    values.push(value)
  }
  return values
}
EOF

cat > test/range.test.js <<'EOF'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { range } from '../src/range.js'

test('range includes both ends', () => {
  assert.deepEqual(range(2, 5), [2, 3, 4, 5])
})

test('range of a single value', () => {
  assert.deepEqual(range(3, 3), [3])
})

test('range with a step lands on end when it can', () => {
  assert.deepEqual(range(0, 10, 5), [0, 5, 10])
})

test('range with a step never passes end', () => {
  assert.deepEqual(range(0, 9, 4), [0, 4, 8])
})

test('range is empty when start is after end', () => {
  assert.deepEqual(range(5, 1), [])
})

test('range rejects a non-positive step', () => {
  assert.throws(() => range(0, 3, 0), RangeError)
})
EOF

git init -q -b main
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "range helper with a failing inclusive-end test"
echo "fixture ready: $DIR"
echo "baseline (expected to fail):"
set +e
node --test 2>&1 | grep -E '^(ℹ|#) (tests|pass|fail) ' || true
