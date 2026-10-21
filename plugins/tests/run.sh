#!/usr/bin/env bash
# Bench for plugins/install.sh against a sandbox profile. Needs a Node and the pnpm entry Desktop
# pins: ROLLOUT_NODE / ROLLOUT_PNPM, defaulting to `node` on PATH and the deepseek-harness
# checkout's apps/desktop/node_modules/pnpm/bin/pnpm.mjs.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; P="$(cd "$HERE/.." && pwd)"
SB="$(mktemp -d)"; SB="$(cd "$SB" && pwd -P)"; trap 'rm -rf "$SB"' EXIT
FAILS=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
ROLLOUT_NODE=${ROLLOUT_NODE:-$(command -v node)}
ROLLOUT_PNPM=${ROLLOUT_PNPM:-$HOME/dev/deepseek-harness/apps/desktop/node_modules/pnpm/bin/pnpm.mjs}
export ROLLOUT_NODE ROLLOUT_PNPM
# The running-Desktop guard matches this identifier prefix; a distinct one keeps the operator's real
# DSH Desktop (com.deepseek.harness…) out of the bench.
export ROLLOUT_BUNDLE_ID=com.deepseek.benchharness
[ -f "$ROLLOUT_PNPM" ] || { echo "skip: no pnpm entry at $ROLLOUT_PNPM"; exit 0; }

OLD="$SB/old-plugins"; mkdir -p "$OLD/provider-limits"
cp "$P/provider-limits/package.json" "$OLD/provider-limits/package.json"
H="$SB/home"; PR="$H/profiles/desktop"; mkdir -p "$PR"
cat > "$PR/package.json" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/dsh-provider-limits": "link:$OLD/provider-limits"
  }
}
EOT
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$PR/pnpm-workspace.yaml"
"$ROLLOUT_NODE" "$ROLLOUT_PNPM" --dir "$PR" install >/dev/null 2>&1

run() { DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_LIVE_HOME="$H" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1; }
out=$(run)
check "install.sh reports the relinked plugin"          '[[ $out == *"1 link plugin(s) now under $P"* ]]'
check "package.json points at dsh-tools/plugins"        'grep -q "\"link:$P/provider-limits\"" "$PR/package.json"'
check "node_modules resolves to dsh-tools/plugins"      '[ "$(cd "$PR/node_modules/@local/dsh-provider-limits" && pwd -P)" = "$P/provider-limits" ]'
out=$(run)
check "a second run changes nothing"                    '[[ $out == *"no link plugin under $OLD"* ]]'
out=$(ROLLOUT_LIVE_HOME="$SB/none" ROLLOUT_TEST_HOME="$SB/none2" bash "$P/install.sh" 2>&1); rc=$?
check "homes without a desktop profile are skipped, exit 0" '[ $rc -eq 0 ]'

# pnpm failure: package.json is restored, the failure is not swallowed on retry
echo 'process.exit(1)' > "$SB/pnpm-fail.mjs"; echo 'process.exit(0)' > "$SB/pnpm-ok.mjs"
H2="$SB/home2"; PR2="$H2/profiles/desktop"; mkdir -p "$PR2"
cat > "$PR2/package.json" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/a": "link:$OLD/provider-limits",
    "@local/b": "link:$OLD-other/x",
    "left-pad": "^1.0.0"
  }
}
EOT
cp "$PR2/package.json" "$SB/before.json"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-fail.mjs" ROLLOUT_LIVE_HOME="$H2" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a failing pnpm makes install.sh exit non-zero"   '[ $rc -ne 0 ]'
check "a failing pnpm leaves package.json byte-identical" 'cmp -s "$PR2/package.json" "$SB/before.json"'
check "a failing pnpm leaves no backup file"            '[ -z "$(ls "$PR2" | grep -F .bak)" ]'
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H2" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "the retry after a failure reruns pnpm and succeeds" '[ $rc -eq 0 ] && [[ $out == *"1 link plugin(s) now under $P"* ]]'
check "only the exact old root is rewritten"            'grep -q "\"@local/a\": \"link:$P/provider-limits\"" "$PR2/package.json" && grep -q "\"@local/b\": \"link:$OLD-other/x\"" "$PR2/package.json" && grep -q "\"left-pad\": \"^1.0.0\"" "$PR2/package.json"'
check "a successful run leaves no backup file"          '[ -z "$(ls "$PR2" | grep -F .bak)" ]'

# interrupted run: the backup holds the original links, package.json is already rewritten
printf 'import fs from "node:fs"\nfs.writeFileSync(process.env.PNPM_MARK, "ran")\n' > "$SB/pnpm-mark.mjs"
H3="$SB/home3"; PR3="$H3/profiles/desktop"; mkdir -p "$PR3"
cat > "$PR3/package.json.dz-relink.bak" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/a": "link:$OLD/provider-limits"
  }
}
EOT
sed "s#link:$OLD/#link:$P/#" "$PR3/package.json.dz-relink.bak" > "$PR3/package.json"
out=$(PNPM_MARK="$SB/mark" DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-mark.mjs" ROLLOUT_LIVE_HOME="$H3" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "an unfinished relink is reported as restored"    '[[ $out == *"$PR3: restored package.json from an unfinished relink"* ]]'
check "an unfinished relink is relinked again, exit 0"  '[ $rc -eq 0 ] && [[ $out == *"1 link plugin(s) now under $P"* ]] && grep -q "\"link:$P/provider-limits\"" "$PR3/package.json"'
check "an unfinished relink reruns pnpm"                '[ -f "$SB/mark" ]'
check "an unfinished relink leaves no backup file"      '[ ! -e "$PR3/package.json.dz-relink.bak" ]'

# a truncated backup never replaces an intact package.json
H4="$SB/home4"; PR4="$H4/profiles/desktop"; mkdir -p "$PR4"
cp "$SB/before.json" "$PR4/package.json"; printf '{ "name": "dsh-pro' > "$PR4/package.json.dz-relink.bak"
cp "$PR4/package.json" "$SB/before4.json"; cp "$PR4/package.json.dz-relink.bak" "$SB/bak4.json"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H4" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a truncated backup stops the run with exit 1"    '[ $rc -eq 1 ] && [[ $out == *"$PR4/package.json changed after an unfinished relink"* ]]'
check "a truncated backup leaves both files untouched"  'cmp -s "$PR4/package.json" "$SB/before4.json" && cmp -s "$PR4/package.json.dz-relink.bak" "$SB/bak4.json"'

# edits made after an interrupted run are not discarded
H5="$SB/home5"; PR5="$H5/profiles/desktop"; mkdir -p "$PR5"
cat > "$PR5/package.json.dz-relink.bak" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/a": "link:$OLD/provider-limits"
  }
}
EOT
cat > "$PR5/package.json" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/a": "link:$P/provider-limits",
    "left-pad": "^1.0.0"
  }
}
EOT
cp "$PR5/package.json" "$SB/before5.json"; cp "$PR5/package.json.dz-relink.bak" "$SB/bak5.json"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H5" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a package.json edited after an interrupted run stops the run" '[ $rc -eq 1 ] && [[ $out == *"$PR5/package.json changed after an unfinished relink"* ]] && [[ $out == *"remove the backup"* ]]'
check "an edited package.json and the backup stay untouched" 'cmp -s "$PR5/package.json" "$SB/before5.json" && cmp -s "$PR5/package.json.dz-relink.bak" "$SB/bak5.json" && grep -q left-pad "$PR5/package.json"'

# a half-written backup copy is discarded
H6="$SB/home6"; PR6="$H6/profiles/desktop"; mkdir -p "$PR6"
cp "$SB/before.json" "$PR6/package.json"; printf '{ "na' > "$PR6/package.json.dz-relink.bak.tmp"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H6" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a leftover backup temp file is removed and the run proceeds" '[ $rc -eq 0 ] && [[ $out == *"1 link plugin(s) now under $P"* ]] && [ -z "$(ls "$PR6" | grep -F .bak)" ]'

# a running DSH Desktop blocks the relink
mkdesk() {
  mkdir -p "$1/Contents/MacOS"; ln -s /bin/sleep "$1/Contents/MacOS/DeepSeek Harness"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>%s</string></dict></plist>\n' "$2" > "$1/Contents/Info.plist"
}
H7="$SB/home7"; PR7="$H7/profiles/desktop"; mkdir -p "$PR7"
cp "$SB/before.json" "$PR7/package.json"; cp "$PR7/package.json" "$SB/before7.json"
run7() { DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H7" ROLLOUT_TEST_HOME="$SB/none" "$@" bash "$P/install.sh" 2>&1; }
mkdesk "$SB/Run Desk.app" com.deepseek.benchharness.dev.x; mkdesk "$SB/Foreign.app" com.example.other
"$SB/Run Desk.app/Contents/MacOS/DeepSeek Harness" 120 & dpid=$!
"$SB/Foreign.app/Contents/MacOS/DeepSeek Harness" 120 & fpid=$!; sleep 0.5
out=$(run7 env); rc=$?
check "a running DSH Desktop stops the run with exit 1"  '[ $rc -eq 1 ] && [[ $out == *"plugins/install.sh: a DSH Desktop is running ($SB/Run Desk.app) — quit it first"* ]]'
check "the refused run leaves package.json untouched"    'cmp -s "$PR7/package.json" "$SB/before7.json" && [ -z "$(ls "$PR7" | grep -F .bak)" ]'
kill "$dpid"; wait "$dpid" 2>/dev/null
out=$(run7 env); rc=$?
check "a running bundle with another identifier does not block" '[ $rc -eq 0 ] && [[ $out == *"1 link plugin(s) now under $P"* ]]'
kill "$fpid"; wait "$fpid" 2>/dev/null
cp "$SB/before.json" "$PR7/package.json"
"$SB/Run Desk.app/Contents/MacOS/DeepSeek Harness" 120 & dpid=$!; sleep 0.5
out=$(run7 env PLUGINS_ALLOW_RUNNING_DESKTOP=1); rc=$?
check "PLUGINS_ALLOW_RUNNING_DESKTOP=1 disables the check" '[ $rc -eq 0 ] && [[ $out == *"1 link plugin(s) now under $P"* ]]'
kill "$dpid"; wait "$dpid" 2>/dev/null

echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
