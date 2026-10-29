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
# install.sh reads the DSH version from ROLLOUT_APP's Info.plist; a fake app at the version the
# plugins pin keeps the operator's installed app (and its version) out of the bench.
mkapp() {
  mkdir -p "$1/Contents"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>%s</string></dict></plist>\n' "$2" > "$1/Contents/Info.plist"
}
DSH_PIN=$("$ROLLOUT_NODE" -e '
  const fs = require("fs"), path = require("path"), root = process.argv[1]
  const pins = new Set()
  for (const dir of fs.readdirSync(root)) {
    const manifest = path.join(root, dir, "package.json")
    if (!fs.existsSync(manifest)) continue
    for (const [name, spec] of Object.entries(JSON.parse(fs.readFileSync(manifest, "utf8")).dependencies || {}))
      if (name.startsWith("@deepseek-ai/dsh-")) pins.add(spec)
  }
  console.log([...pins].join(" "))' "$P")
case $DSH_PIN in *" "*) echo "FAIL plugins pin different DSH versions: $DSH_PIN"; exit 1 ;; esac
mkapp "$SB/Pinned DSH.app" "${DSH_PIN:-0.0.0}"
export ROLLOUT_APP="$SB/Pinned DSH.app"

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

# package.json keeps its file mode across the rewrite
H8="$SB/home8"; PR8="$H8/profiles/desktop"; mkdir -p "$PR8"
cp "$SB/before.json" "$PR8/package.json"; chmod 600 "$PR8/package.json"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H8" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a rewritten package.json keeps mode 600" '[ $rc -eq 0 ] && grep -q "link:$P/provider-limits" "$PR8/package.json" && [ "$(stat -f %Lp "$PR8/package.json")" = 600 ]'

# missing dsh-tools plugins are connected: link dependency plus a bundle after the last @local/ one
H9="$SB/home9"; PR9="$H9/profiles/desktop"; mkdir -p "$PR9"
cat > "$PR9/package.json" <<EOT
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/dsh-provider-limits": "link:$P/provider-limits"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@local/dsh-provider-limits",
        "@deepseek-ai/dsh-experimental-session-search"
      ]
    }
  }
}
EOT
cp "$PR9/package.json" "$SB/before9.json"
run9() { DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_LIVE_HOME="$H9" ROLLOUT_TEST_HOME="$SB/none" "$@" bash "$P/install.sh" 2>&1; }
bundles9() { "$ROLLOUT_NODE" -e 'console.log(require(process.argv[1]).dsh.profile.bundles.join(","))' "$PR9/package.json"; }
out=$(run9 env PLUGINS_ENSURE=""); rc=$?
check "PLUGINS_ENSURE=\"\" connects nothing"              '[ $rc -eq 0 ] && cmp -s "$PR9/package.json" "$SB/before9.json"'
out=$(run9 env PLUGINS_ENSURE="nope" ROLLOUT_PNPM="$SB/pnpm-ok.mjs"); rc=$?
check "PLUGINS_ENSURE naming a missing plugin stops the run, package.json untouched" \
  '[ $rc -eq 1 ] && [[ $out == *"PLUGINS_ENSURE names nope"* ]] && cmp -s "$PR9/package.json" "$SB/before9.json" && [ -z "$(ls "$PR9" | grep -F .bak)" ]'
rm -f "$SB/mark"
out=$(PNPM_MARK="$SB/mark" run9 env ROLLOUT_PNPM="$SB/pnpm-mark.mjs"); rc=$?
check "a missing plugin is reported as connected and pnpm runs" \
  '[ $rc -eq 0 ] && [[ $out == *"$PR9: connected @local/dsh-device-reservations"* ]] && [ -f "$SB/mark" ]'
check "the connected plugin gets a link dependency"     'grep -q "\"@local/dsh-device-reservations\": \"link:$P/device-reservations\"" "$PR9/package.json"'
check "the bundle goes right after the last @local/ bundle" \
  '[ "$(bundles9)" = "@deepseek-ai/dsh-base,@local/dsh-provider-limits,@local/dsh-device-reservations,@deepseek-ai/dsh-experimental-session-search" ]'
cp "$PR9/package.json" "$SB/after9.json"; rm -f "$SB/mark"
out=$(PNPM_MARK="$SB/mark" run9 env ROLLOUT_PNPM="$SB/pnpm-mark.mjs"); rc=$?
check "a connected profile is left alone on the next run" \
  '[ $rc -eq 0 ] && [[ $out == *"no plugin to connect"* ]] && [ ! -f "$SB/mark" ] && cmp -s "$PR9/package.json" "$SB/after9.json"'
# an interrupted connection is restored and redone
cp "$SB/before9.json" "$PR9/package.json.dz-relink.bak"; cp "$SB/after9.json" "$PR9/package.json"
out=$(run9 env ROLLOUT_PNPM="$SB/pnpm-ok.mjs"); rc=$?
check "an interrupted connection is restored and redone" \
  '[ $rc -eq 0 ] && [[ $out == *"restored package.json from an unfinished relink"* ]] && cmp -s "$PR9/package.json" "$SB/after9.json" && [ ! -e "$PR9/package.json.dz-relink.bak" ]'
# a profile without a bundles list gets a warning and no dependency
H10="$SB/home10"; PR10="$H10/profiles/desktop"; mkdir -p "$PR10"
printf '{\n  "name": "dsh-profile-desktop",\n  "private": true\n}\n' > "$PR10/package.json"; cp "$PR10/package.json" "$SB/before10.json"
out=$(DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H10" ROLLOUT_TEST_HOME="$SB/none" bash "$P/install.sh" 2>&1); rc=$?
check "a profile without dsh.profile.bundles is warned about and left untouched" \
  '[ $rc -eq 0 ] && [[ $out == *"no dsh.profile.bundles list; @local/dsh-device-reservations not connected"* ]] && cmp -s "$PR10/package.json" "$SB/before10.json"'

# ROLLOUT_HOOK_SCOPE=test fixes only the test home and ignores Desktops outside it
H11="$SB/home11"; PR11="$H11/profiles/desktop"; mkdir -p "$PR11"; cp "$SB/before.json" "$PR11/package.json"; cp "$PR11/package.json" "$SB/before11.json"
H12="$SB/home12"; PR12="$H12/profiles/desktop"; mkdir -p "$PR12"; cp "$SB/before.json" "$PR12/package.json"
run12() { DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_LIVE_HOME="$H11" ROLLOUT_TEST_HOME="$H12" ROLLOUT_HOOK_SCOPE=test "$@" bash "$P/install.sh" 2>&1; }
"$SB/Run Desk.app/Contents/MacOS/DeepSeek Harness" 120 & dpid=$!; sleep 0.5
out=$(run12 env); rc=$?
check "scope=test: a Desktop outside the test home does not block" '[ $rc -eq 0 ] && [[ $out == *"$PR12: 1 link plugin(s) now under $P"* ]]'
check "scope=test: the live home stays untouched"       'cmp -s "$PR11/package.json" "$SB/before11.json" && [[ $out != *"$PR11"* ]]'
kill "$dpid"; wait "$dpid" 2>/dev/null
cp "$SB/before.json" "$PR12/package.json"; cp "$PR12/package.json" "$SB/before12.json"
mkdesk "$H12/artifacts/abc/Test Desk.app" com.deepseek.benchharness
"$H12/artifacts/abc/Test Desk.app/Contents/MacOS/DeepSeek Harness" 120 & tpid=$!; sleep 0.5
out=$(run12 env); rc=$?
check "scope=test: the test instance blocks the run"    '[ $rc -eq 1 ] && [[ $out == *"a DSH Desktop is running ($H12/artifacts/abc/Test Desk.app)"* ]] && cmp -s "$PR12/package.json" "$SB/before12.json"'
kill "$tpid"; wait "$tpid" 2>/dev/null
out=$(ROLLOUT_HOOK_SCOPE=live bash "$P/install.sh" 2>&1); rc=$?
check "an unknown ROLLOUT_HOOK_SCOPE is refused"        '[ $rc -eq 1 ] && [[ $out == *"ROLLOUT_HOOK_SCOPE must be all or test"* ]]'

# a DSH pin that differs from ROLLOUT_APP's version stops the run before anything changes
if [ -n "$DSH_PIN" ]; then
  H13="$SB/home13"; PR13="$H13/profiles/desktop"; mkdir -p "$PR13"; cp "$SB/before.json" "$PR13/package.json"; cp "$PR13/package.json" "$SB/before13.json"
  mkapp "$SB/Newer DSH.app" 99.0.0-bench
  run13() { DSH_TOOLS_OLD_PLUGINS="$OLD" ROLLOUT_PNPM="$SB/pnpm-ok.mjs" ROLLOUT_APP="$SB/Newer DSH.app" ROLLOUT_LIVE_HOME="$H13" ROLLOUT_TEST_HOME="$SB/none" "$@" bash "$P/install.sh" 2>&1; }
  out=$(run13 env); rc=$?
  check "a stale DSH pin stops the run with exit 1 and names the fix" \
    '[ $rc -eq 1 ] && [[ $out == *"pins @deepseek-ai/dsh-"*"@$DSH_PIN, but $SB/Newer DSH.app is DSH 99.0.0-bench."* ]] && [[ $out == *"Fix: set"*": \"99.0.0-bench\""* ]]'
  check "a stale DSH pin leaves package.json untouched"  'cmp -s "$PR13/package.json" "$SB/before13.json" && [ -z "$(ls "$PR13" | grep -F .bak)" ]'
  out=$(run13 env PLUGINS_ALLOW_DSH_VERSION_MISMATCH=1); rc=$?
  check "PLUGINS_ALLOW_DSH_VERSION_MISMATCH=1 reports the stale pin and continues" \
    '[ $rc -eq 0 ] && [[ $out == *"continuing with the old pins"* ]] && [[ $out == *"1 link plugin(s) now under $P"* ]]'
fi
mkdir -p "$SB/No Version.app/Contents"; echo '<plist version="1.0"><dict/></plist>' > "$SB/No Version.app/Contents/Info.plist"
out=$(ROLLOUT_APP="$SB/No Version.app" ROLLOUT_LIVE_HOME="$SB/none" ROLLOUT_TEST_HOME="$SB/none2" bash "$P/install.sh" 2>&1); rc=$?
check "an app without a version is refused"            '[ $rc -eq 1 ] && [[ $out == *"cannot read the DSH version"* ]]'

# --help prints exactly the header comment
out=$(bash "$P/install.sh" --help 2>&1); rc=$?
check "install.sh --help: the whole header comment, nothing after it" \
  '[ $rc -eq 0 ] && [[ $(echo "$out" | tail -1) == "#"* && $(echo "$out" | grep -vc "^#") -eq 0 && $(echo "$out" | wc -l) -eq $(awk "NR>1 && /^[^#]/{print NR-2; exit}" "$P/install.sh") ]]'

echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
