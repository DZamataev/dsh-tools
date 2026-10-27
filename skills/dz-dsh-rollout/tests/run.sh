#!/usr/bin/env bash
# Bench for dz-dsh-rollout: a throwaway fork with feature worktrees, fake homes, fake bundles and
# synthetic session logs. Touches nothing outside its mktemp sandbox; never starts, quits or opens a
# real DSH app (deploy runs with --no-relaunch while no app at the sandbox app path runs).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../scripts"
SB="$(mktemp -d)"; SB="$(cd "$SB" && pwd -P)"
# shellcheck disable=SC2046  # one pid per word
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$SB"' EXIT
FAILS=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
lib() { bash -c '. "$1"; trap - EXIT; shift; "$@"' _ "$S/lib.sh" "$@"; }
# A bundle whose executable is a symlink to /bin/sleep (a copied system binary gets SIGKILLed).
mkbundle() { mkdir -p "$1/Contents/MacOS"; ln -s /bin/sleep "$1/Contents/MacOS/DeepSeek Harness"; }
# ... with an Info.plist: $1 = bundle, $2 = CFBundleIdentifier.
mkdesk() {
  mkbundle "$1"
  cat > "$1/Contents/Info.plist" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>$2</string></dict></plist>
EOP
}
# A zstd session log: $1 = home, $2 = session id, then the event types in order.
session() {
  local d="$1/sessions/--proj--/$2" t; mkdir -p "$d"; shift 2
  { echo '{"type":"session","version":4,"id":"x"}'
    for t in "$@"; do echo '{"type":"'"$t"'","seq":1,"time":1792578548041,"data":{"turn":1}}'; done
  } | zstd -qf -o "$d/session.v4.jsonl.zstd"
}

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL="$SB/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global init.defaultBranch master
git config --global commit.gpgsign false
commit() { echo "$3" > "$1/$2"; git -C "$1" add "$2"; git -C "$1" commit -qm "$4"; }

# upstream (remote deepseek-ai) → fork (develop) → feature worktrees + the detached build worktree
git init -q "$SB/upstream"; commit "$SB/upstream" base.txt base "initial"
git clone -q "$SB/upstream" "$SB/fork" 2>/dev/null
git -C "$SB/fork" remote rename origin deepseek-ai
git -C "$SB/fork" checkout -q -b develop
WT="$SB/wt"; mkdir -p "$WT"
git -C "$SB/fork" worktree add -q -b feat/a "$WT/a"; commit "$WT/a" a.txt a "feat: a"
git -C "$SB/fork" worktree add -q -b feat/clean "$WT/clean"
git -C "$SB/fork" worktree add -q --detach "$WT/rollout-build"
git -C "$SB/fork" worktree add -q -b outside/x "$SB/elsewhere"; commit "$SB/elsewhere" x.txt x "feat: x"
commit "$SB/upstream" up.txt up "upstream change"

LIVE="$SB/live"; TEST="$SB/test"; APPDIR="$SB/Applications"
mkdir -p "$LIVE/logs" "$APPDIR" "$SB/cfg"
cat > "$SB/cfg/config.sh" <<EOF
ROLLOUT_FORK=$SB/fork
ROLLOUT_BRANCH=develop
ROLLOUT_WT_ROOT=$WT
ROLLOUT_BUILD_WT=$WT/rollout-build
ROLLOUT_UPSTREAM=deepseek-ai/master
ROLLOUT_LIVE_HOME=$LIVE
ROLLOUT_TEST_HOME=$TEST
ROLLOUT_APP="$APPDIR/DeepSeek Harness.app"
ROLLOUT_SIGN_IDENTITY=-
ROLLOUT_LEGACY_APP=
ROLLOUT_POST_DEPLOY='echo hook-ran > "\$ROLLOUT_LIVE_HOME/hook.out"'
ROLLOUT_PROFILE_SETUP=$SB/profile-setup.sh
EOF
# Records its home, source checkout and ALLOW_LIVE. It also deletes the post-deploy hook's output, so
# "deploy runs the post-deploy hook" passes only when the hook runs after the setup.
printf '#!/bin/sh\necho "$1 $ROLLOUT_SRC $ALLOW_LIVE" >> "%s/setup.calls"\nrm -f "$1/hook.out"\n' "$SB" > "$SB/profile-setup.sh"
chmod +x "$SB/profile-setup.sh"
export ROLLOUT_CONFIG="$SB/cfg/config.sh" ROLLOUT_NO_NOTIFY=1 ROLLOUT_STOP_TIMEOUT=5
# Desktop detection matches the bundle identifier prefix; a distinct one keeps the operator's real
# DSH Desktop (com.deepseek.harness…) out of the bench.
export ROLLOUT_BUNDLE_ID=com.deepseek.benchharness
# The bench may run inside DSH or Claude Code: deploy.sh would refuse everything but --dry-run.
unset DSH_SESSION_ID DSH_SHELL CLAUDECODE

# ── lib: live turns ──
TH="$SB/turns"
session "$TH" S_OPEN turn/start
session "$TH" S_DONE turn/start turn/end
session "$TH" S_REOPENED turn/start turn/end turn/start
session "$TH" S_STALE turn/start
touch -t "$(date -v-20H +%Y%m%d%H%M)" "$TH/sessions/--proj--/S_STALE/session.v4.jsonl.zstd"
turns=$(lib live_turns "$TH" | sed -E 's/^.*: ([^ ]+) since .*$/\1/' | sort | tr '\n' ' ')
check "live_turns: open and reopened turns, not finished or stale ones" '[ "$turns" = "S_OPEN S_REOPENED " ]'
turns=$(lib live_turns "$SB/nohome"); rc=$?
check "live_turns: a home without sessions has none, exit 0" '[ -z "$turns" ] && [ $rc -eq 0 ]'
# zstd lives in /opt/homebrew/bin; system dirs hide it. BASH_ENV may re-add PATH entries in a child bash.
NOZSTD="env BASH_ENV= PATH=/usr/bin:/bin"
err=$($NOZSTD bash -c '. "$1"; trap - EXIT; live_turns "$2"' _ "$S/lib.sh" "$TH" 2>&1 >/dev/null); rc=$?
check "live_turns: without zstd it fails closed (non-zero, message on stderr)" \
  '[ $rc -ne 0 ] && [[ "$err" == *"zstd is required"* ]] && ! $NOZSTD bash -c "command -v zstd" >/dev/null'

# ── lib: processes by executable path ──
mkbundle "$SB/Fake.app"; "$SB/Fake.app/Contents/MacOS/DeepSeek Harness" 120 & fake=$!; sleep 0.5
check "bundle_pids: finds a bundle's process by executable path" '[ "$(lib bundle_pids "$SB/Fake.app")" = "$fake" ]'
check "bundle_pids: no match for another bundle"         '[ -z "$(lib bundle_pids "$SB/Other.app")" ]'
check "bundle_pids: an empty path matches nothing"       '[ -z "$(lib bundle_pids "")" ]'
kill "$fake"; wait "$fake" 2>/dev/null
mkdesk "$SB/Desk One.app" com.deepseek.benchharness; mkdesk "$SB/Desk Dev.app" com.deepseek.benchharness.dev.x
mkdesk "$SB/Desk Foreign.app" com.example.other; mkdesk "$SB/Desk Host.app/Contents/Frameworks/Helper.app" com.deepseek.benchharness.helper
"$SB/Desk One.app/Contents/MacOS/DeepSeek Harness" 120 & d1=$!
"$SB/Desk Dev.app/Contents/MacOS/DeepSeek Harness" 120 & d2=$!
"$SB/Desk Foreign.app/Contents/MacOS/DeepSeek Harness" 120 & d3=$!
"$SB/Desk Host.app/Contents/Frameworks/Helper.app/Contents/MacOS/DeepSeek Harness" 120 & d4=$!
mkbundle "$SB/Desk NoPlist.app"; "$SB/Desk NoPlist.app/Contents/MacOS/DeepSeek Harness" 120 & d5=$!
sleep 0.5
dp=$(lib desktop_pids)
check "desktop_pids: a bundle with the DSH identifier, as '<pid> <bundle>'" '[[ $dp == *"$d1 $SB/Desk One.app"* ]]'
check "desktop_pids: an identifier below the DSH prefix"  '[[ $dp == *"$d2 $SB/Desk Dev.app"* ]]'
check "desktop_pids: not another identifier, a nested helper or a bundle without Info.plist" \
  '[[ $dp != *"Desk Foreign"* && $dp != *Helper* && $dp != *NoPlist* ]]'
kill $d1 $d2 $d3 $d4 $d5; wait $d1 $d2 $d3 $d4 $d5 2>/dev/null
mkbundle "$TEST/artifacts/abc123/DeepSeek Harness.app"
"$TEST/artifacts/abc123/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" 120 & tpid=$!; sleep 0.5
check "test_instance_pids: a process under the artifacts dir" '[ "$(lib test_instance_pids)" = "$tpid" ]'
check "test_instance_sha: names the artifact sha"        '[ "$(lib test_instance_sha)" = abc123 ]'
lib stop_test_instance >/dev/null 2>&1
check "stop_test_instance: stops it"                     '! kill -0 '"$tpid"' 2>/dev/null'
wait "$tpid" 2>/dev/null
rm -rf "$TEST/artifacts/abc123"

# ── lib: quit_bundle reports osascript errors (a fake osascript; never the real one) ──
FAKEBIN="$SB/fakebin"; mkdir -p "$FAKEBIN"
mkbundle "$SB/Quit.app"; "$SB/Quit.app/Contents/MacOS/DeepSeek Harness" 120 & qpid=$!; sleep 0.5
printf '#!/bin/sh\necho "execution error: Not authorized to send Apple events to X. (-1743)" >&2\nexit 1\n' > "$FAKEBIN/osascript"
chmod +x "$FAKEBIN/osascript"
start=$SECONDS; out=$(PATH="$FAKEBIN:$PATH" lib quit_bundle "$SB/Quit.app" 2>&1); rc=$?
check "quit_bundle: a refused Apple event (-1743) fails at once with the Automation hint" \
  '[ $rc -ne 0 ] && [ $((SECONDS - start)) -lt 10 ] && [[ $out == *"macOS refused the Apple event to quit $SB/Quit.app — allow your terminal to control it in System Settings → Privacy & Security → Automation, then deploy again; nothing installed"* ]]'
printf '#!/bin/sh\necho "boom: no such app" >&2\necho second >&2\nexit 2\n' > "$FAKEBIN/osascript"
start=$SECONDS; out=$(PATH="$FAKEBIN:$PATH" lib quit_bundle "$SB/Quit.app" 2>&1); rc=$?
check "quit_bundle: another osascript error names its first stderr line" \
  '[ $rc -ne 0 ] && [ $((SECONDS - start)) -lt 10 ] && [[ $out == *"osascript could not quit $SB/Quit.app: boom: no such app — nothing installed"* && $out != *second* ]]'
printf '#!/bin/sh\nexit 0\n' > "$FAKEBIN/osascript"
out=$(PATH="$FAKEBIN:$PATH" ROLLOUT_QUIT_TIMEOUT=2 lib quit_bundle "$SB/Quit.app" 2>&1); rc=$?
check "quit_bundle: a quit that does not happen times out with the dialog hint" \
  '[ $rc -ne 0 ] && [[ $out == *"$SB/Quit.app is still running after 2 s — answer or dismiss its quit dialog (Quit only if nothing runs), then deploy again; nothing installed"* ]]'
kill "$qpid"; wait "$qpid" 2>/dev/null
rm -f "$FAKEBIN/osascript"

# ── lib: test home seed ──
SRC="$SB/seed-src"; DST="$SB/seed-dst"
mkdir -p "$SRC/profiles/desktop/node_modules/@local" "$SRC/storages" "$SRC/sessions/p/s" "$SRC/mobile-access" "$SRC/profiles/web" "$SB/plugin-target"
echo 'K=1' > "$SRC/.env"; echo 'records: {}' > "$SRC/.credentials.yaml"; echo '[]' > "$SRC/cordis.patch.yml"
echo '{}' > "$SRC/storages/workspace.json"; echo '{}' > "$SRC/storages/session_projcache.json"
echo '[]' > "$SRC/profiles/desktop/cordis.patch.yml"; echo '{"name":"p"}' > "$SRC/profiles/desktop/package.json"
ln -s ../../../../../plugin-target "$SRC/profiles/desktop/node_modules/@local/p"
lib seed_test_home "$SRC" "$DST"
check "seed: .env, home patch, workspace list and the desktop profile" \
  '[ -f "$DST/.env" ] && [ -f "$DST/cordis.patch.yml" ] && [ -f "$DST/storages/workspace.json" ] && [ -f "$DST/profiles/desktop/package.json" ] && [ -f "$DST/profiles/desktop/cordis.patch.yml" ]'
check "seed: .env is owner-only"                         '[ "$(stat -f %Lp "$DST/.env")" = 600 ]'
check "seed: no credentials, sessions, mobile access, other profiles or project cache" \
  '[ ! -e "$DST/.credentials.yaml" ] && [ ! -e "$DST/sessions" ] && [ ! -e "$DST/mobile-access" ] && [ ! -e "$DST/profiles/web" ] && [ ! -e "$DST/storages/session_projcache.json" ]'
check "seed: relative plugin links resolve at the same depth" \
  '[ "$(cd "$DST/profiles/desktop/node_modules/@local/p" && pwd -P)" = "$SB/plugin-target" ]'

# ── lib: signing and bundle install ──
mkdir -p "$SB/Sign.app/Contents/MacOS"; cp /usr/bin/true "$SB/Sign.app/Contents/MacOS/Sign"
cat > "$SB/Sign.app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.deepseek.harness</string>
<key>CFBundleExecutable</key><string>Sign</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
check "sign_bundle: an ad-hoc signature verifies strictly" 'lib sign_bundle "$SB/Sign.app" - >/dev/null 2>&1'
check "requirement_ok: an ad-hoc identity needs no certificate" 'lib requirement_ok "$SB/Sign.app" -'
mkdir -p "$SB/inst/Old.app/Contents"; echo old > "$SB/inst/Old.app/Contents/old"
lib install_bundle "$SB/Sign.app" "$SB/inst/Old.app" >/dev/null 2>&1
check "install_bundle: replaces the bundle, no .new/.old left" \
  '[ -f "$SB/inst/Old.app/Contents/MacOS/Sign" ] && [ ! -e "$SB/inst/Old.app/Contents/old" ] && [ ! -e "$SB/inst/Old.app.new" ] && [ ! -e "$SB/inst/Old.app.old" ]'

# ── merge.sh ──
out=$("$S/merge.sh" --dry-run 2>&1)
check "merge dry run lists the worktree branch ahead"   '[[ $out == *"to merge: feat/a (+1"* ]]'
check "merge dry run reports an up-to-date branch"      '[[ $out == *"up to date: feat/clean"* ]]'
check "merge dry run skips the build worktree"          '[[ $out != *"rollout-build"* ]]'
check "merge dry run skips worktrees outside WT_ROOT"   '[[ $out != *"outside/x"* ]]'
check "merge dry run merges nothing"                    '[ ! -f "$SB/fork/a.txt" ]'
check "merge dry run ends with the result line"         '[[ $(echo "$out" | tail -1) == "MERGE OK: dry run"* ]]'
out=$(ROLLOUT_WT_ROOT= "$S/merge.sh" --dry-run 2>&1)
check "env var overrides the config file (all worktrees)" '[[ $out == *"to merge: outside/x"* && $out != *"rollout-build"* ]]'
out=$(ROLLOUT_CONFIG="$SB/none.sh" ROLLOUT_FORK= "$S/merge.sh" --dry-run 2>&1)
check "missing config is reported"                      '[[ $out == *"MERGE FAILED: ROLLOUT_FORK is not set"* ]]'
out=$(ROLLOUT_TEST_HOME="$LIVE" "$S/merge.sh" --dry-run 2>&1)
check "config: the same live and test home is refused"  '[[ $out == *"MERGE FAILED: ROLLOUT_TEST_HOME and ROLLOUT_LIVE_HOME overlap: "* ]]'
out=$(ROLLOUT_TEST_HOME="$LIVE/nested" "$S/merge.sh" --dry-run 2>&1)
check "config: a test home inside the live home is refused" '[[ $out == *"ROLLOUT_TEST_HOME and ROLLOUT_LIVE_HOME overlap: "* ]]'
out=$(ROLLOUT_LIVE_HOME="$TEST/nested" "$S/merge.sh" --dry-run 2>&1)
check "config: a live home inside the test home is refused" '[[ $out == *"ROLLOUT_TEST_HOME and ROLLOUT_LIVE_HOME overlap: "* ]]'
ln -s "$LIVE" "$SB/live-link"
out=$(ROLLOUT_TEST_HOME="$SB/live-link" "$S/merge.sh" --dry-run 2>&1)
check "config: overlap is judged on resolved paths"     '[[ $out == *"ROLLOUT_TEST_HOME and ROLLOUT_LIVE_HOME overlap: "* ]]'
out=$(ROLLOUT_BUILD_WT="$SB/fork" "$S/merge.sh" --dry-run 2>&1)
check "config: the fork checkout as build worktree is refused" '[[ $out == *"MERGE FAILED: ROLLOUT_BUILD_WT must be a separate worktree, not the fork checkout: "* ]]'
out=$(ROLLOUT_BUILD_WT="$SB/fork/build" "$S/merge.sh" --dry-run 2>&1)
check "config: a build worktree inside the fork is refused" '[[ $out == *"ROLLOUT_BUILD_WT must be a separate worktree, not the fork checkout: "* ]]'
git init -q "$SB/otherrepo"
out=$(ROLLOUT_BUILD_WT="$SB/otherrepo" "$S/merge.sh" --dry-run 2>&1)
check "config: a build worktree of another repository is refused" '[[ $out == *"MERGE FAILED: ROLLOUT_BUILD_WT is not a worktree of ROLLOUT_FORK: "* ]]'
out=$("$S/merge.sh" --dry-run 2>&1)
check "config: the regular worktree passes"             '[[ $out == *"MERGE OK"* ]]'
out=$("$S/merge.sh" --upstream 2>&1)
check "merge.sh --upstream succeeds"                    '[[ $out == *"MERGE OK"* ]]'
check "upstream merged into develop"                    '[ -f "$SB/fork/up.txt" ]'
check "feature branch merged into develop"              '[ -f "$SB/fork/a.txt" ]'
git -C "$WT/clean" checkout -q -b feat/conflict; commit "$WT/clean" a.txt other "conflicting a"
git -C "$WT/clean" checkout -q feat/clean; git -C "$WT/clean" reset -q --hard feat/conflict
out=$("$S/merge.sh" 2>&1)
check "a conflict fails with the branch named"          '[[ $out == *"MERGE FAILED: merge conflict: feat/clean"* ]]'
check "a conflict leaves develop clean (aborted)"       '[ -z "$(git -C "$SB/fork" status --porcelain --untracked-files=no)" ]'
git -C "$WT/clean" reset -q --hard develop
git -C "$SB/fork" branch -q -D feat/conflict

# ── run_test_hook (verify's post-deploy hook on the test home) ──
hookcmd='printf "%s|%s|%s|%s\n" "$ROLLOUT_HOOK_SCOPE" "$ROLLOUT_APP" "$ROLLOUT_LIVE_HOME" "$ROLLOUT_TEST_HOME" > "$ROLLOUT_TEST_HOME/hook.env"'
mkdir -p "$TEST"; rm -f "$TEST/hook.env"
(ROLLOUT_POST_DEPLOY="$hookcmd" bash -c '. "$1/lib.sh"; trap - EXIT; run_test_hook "/art/DeepSeek Harness.app"' run "$S" >/dev/null 2>&1)
check "run_test_hook runs the hook with scope test, the artifact, and both homes" \
  '[ "$(cat "$TEST/hook.env" 2>/dev/null)" = "test|/art/DeepSeek Harness.app|$LIVE|$TEST" ]'
rm -f "$TEST/hook.env"
(ROLLOUT_POST_DEPLOY= bash -c '. "$1/lib.sh"; trap - EXIT; run_test_hook /art' run "$S" >/dev/null 2>&1); rc=$?
check "run_test_hook without a hook runs nothing and succeeds" '[ $rc -eq 0 ] && [ ! -e "$TEST/hook.env" ]'
check "verify.sh calls run_test_hook after the profile setup and before the start" \
  '[ "$(grep -nE "run_profile_setup \"\\\$TEST_HOME\"|run_test_hook \"\\\$ART\"|step \"start test instance\"" "$S/verify.sh" | cut -d: -f1 | tr "\n" " ")" = "$(grep -nE "run_profile_setup \"\\\$TEST_HOME\"|run_test_hook \"\\\$ART\"|step \"start test instance\"" "$S/verify.sh" | cut -d: -f1 | sort -n | tr "\n" " ")" ] && [ "$(grep -cE "run_test_hook \"\\\$ART\"" "$S/verify.sh")" = 1 ]'

# ── verify.sh ──
mkbundle "$TEST/artifacts/def456/DeepSeek Harness.app"
"$TEST/artifacts/def456/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" 120 & tpid=$!; sleep 0.5
out=$("$S/verify.sh" --stop 2>&1)
check "verify --stop stops the test instance"           '[[ $out == *"VERIFY OK: test instance stopped"* ]] && ! kill -0 '"$tpid"' 2>/dev/null'
wait "$tpid" 2>/dev/null; rm -rf "$TEST/artifacts/def456"
out=$("$S/verify.sh" --bogus 2>&1)
check "verify rejects an unknown argument"              '[[ $out == *"VERIFY FAILED: unknown argument: --bogus"* ]]'
out=$(ROLLOUT_SIGN_IDENTITY= "$S/verify.sh" --no-tests 2>&1)
check "verify requires a sign identity"                 '[[ $out == *"VERIFY FAILED: ROLLOUT_SIGN_IDENTITY is not set"* ]]'
out=$("$S/verify.sh" --since 2>&1)
check "verify --since needs a REF"                      '[[ $out == *"VERIFY FAILED: --since needs a REF"* ]]'
# (BASH_ENV= keeps a shell startup file from reordering PATH) a fake pnpm stops verify after the stamp handling and records the DSH_HOME it ran with
mkdir -p "$SB/fakepnpm"; printf '#!/bin/sh\necho "$DSH_HOME" > "%s/pnpm.dshhome"\nexit 1\n' "$SB" > "$SB/fakepnpm/pnpm"; chmod +x "$SB/fakepnpm/pnpm"
VSHA=$(git -C "$SB/fork" rev-parse develop); mkdir -p "$LIVE/logs/rollout"
echo "$VSHA old tests=changed app=true artifact=x" > "$LIVE/logs/rollout/verified"
out=$(BASH_ENV= DSH_HOME=/should/not/leak PATH="$SB/fakepnpm:$PATH" "$S/verify.sh" --no-tests 2>&1)
check "verify clears the stamp that names its sha"      '[[ $out == *"previous verified stamp for "*" cleared"* ]] && [ ! -e "$LIVE/logs/rollout/verified" ]'
rm -rf "$(cat "$SB/pnpm.dshhome")"
echo "0000000000000000000000000000000000000000 old tests=changed app=true artifact=x" > "$LIVE/logs/rollout/verified"
BASH_ENV= PATH="$SB/fakepnpm:$PATH" "$S/verify.sh" --no-tests >/dev/null 2>&1
check "verify keeps a stamp that names another sha"     '[ -s "$LIVE/logs/rollout/verified" ]'
rm -f "$LIVE/logs/rollout/verified"
vh=$(cat "$SB/pnpm.dshhome")
check "verify runs builds with a throwaway DSH_HOME (not live, test or the caller's)" \
  '[ -n "$vh" ] && [ "$vh" != "$LIVE" ] && [ "$vh" != "$TEST" ] && [ "$vh" != /should/not/leak ] && [ -d "$vh" ]'
rm -rf "$vh"

# ── deploy.sh ──
st() { "$S/state.sh" | grep "^$1=" | cut -d= -f2-; }
FORKSHA=$(git -C "$SB/fork" rev-parse develop)
out=$("$S/deploy.sh" --dry-run 2>&1)
check "deploy dry run warns on an unverified sha"       '[[ $out == *"WARNING: develop"*"is not verified"* ]]'
check "deploy dry run warns on a missing artifact"      '[[ $out == *"WARNING: no valid artifact"* ]]'
check "deploy dry run ends with the result line"        '[[ $(echo "$out" | tail -1) == "DEPLOY OK: dry run" ]]'
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses an unverified sha"                '[[ $out == *"DEPLOY FAILED"*"is not verified"* ]]'
mkdir -p "$LIVE/logs/rollout"
echo "$FORKSHA now tests=changed app=true artifact=x" > "$LIVE/logs/rollout/verified"
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses a verified sha without an artifact" '[[ $out == *"DEPLOY FAILED: no valid artifact"* ]]'
mkdir -p "$TEST/artifacts/$FORKSHA"; ditto "$SB/Sign.app" "$TEST/artifacts/$FORKSHA/DeepSeek Harness.app"
out=$("$S/deploy.sh" --dry-run 2>&1)
check "deploy dry run accepts a verified sha with its artifact" '[[ $out == *"verified: "* && $out == *"artifact: "* && $out != *WARNING* ]]'
echo dirty >> "$SB/fork/base.txt"
out=$("$S/deploy.sh" --dry-run 2>&1)
check "deploy refuses a dirty fork"                     '[[ $out == *"has uncommitted changes"* ]]'
git -C "$SB/fork" checkout -q -- base.txt
out=$(ROLLOUT_SIGN_IDENTITY="Developer ID Application: Bench (ABCDE12345)" "$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses an artifact not signed by the configured identity" '[[ $out == *"DEPLOY FAILED: artifact $TEST/artifacts/$FORKSHA/DeepSeek Harness.app is not signed by Developer ID Application: Bench (ABCDE12345) (run verify.sh)"* ]]'
out=$(ROLLOUT_SIGN_IDENTITY="Developer ID Application: Bench (ABCDE12345)" "$S/deploy.sh" --dry-run 2>&1)
check "the dry run warns about it"                      '[[ $out == *"WARNING: artifact"*"is not signed by"* ]]'
out=$(ROLLOUT_SIGN_IDENTITY= "$S/deploy.sh" --dry-run 2>&1)
check "deploy needs a sign identity"                    '[[ $out == *"ROLLOUT_SIGN_IDENTITY is not set"* ]]'
out=$(DSH_SESSION_ID=x "$S/deploy.sh" --push 2>&1)
check "deploy refuses inside a DSH agent session"       '[[ $out == *"DEPLOY FAILED: deploy is run by the operator"* ]]'
check "the refusal prints the absolute command"         '[[ $out == *"  $(cd "$S" && pwd)/deploy.sh --push"* ]]'
out=$(DSH_SHELL=1 "$S/deploy.sh" 2>&1)
check "deploy refuses inside a DSH terminal"            '[[ $out == *"DEPLOY FAILED: deploy is run by the operator"* ]]'
out=$(DSH_SESSION_ID=x "$S/deploy.sh" --dry-run 2>&1)
check "a dry run works inside DSH and names the command" '[[ $out == *"DEPLOY OK: dry run"* && $out == *"the operator runs"* ]]'
mkbundle "$APPDIR/DeepSeek Harness.app"
"$APPDIR/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" 120 & lpid=$!; sleep 0.5
session "$LIVE" S_LIVE turn/start
out=$("$S/deploy.sh" --dry-run 2>&1)
check "deploy dry run lists a running turn of the live app" '[[ $out == *"running turns:"*"S_LIVE"* ]]'
out=$(env BASH_ENV= PATH=/usr/bin:/bin "$S/deploy.sh" --dry-run 2>&1)
check "deploy dry run fails closed when turns cannot be read (no zstd)" '[[ $out == *"DEPLOY FAILED: cannot read open turns in"* ]]'
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses while the live app has a turn running" '[[ $out == *"DEPLOY FAILED"*"turn(s) still running"* ]] && kill -0 '"$lpid"
kill "$lpid"; wait "$lpid" 2>/dev/null
rm -rf "$APPDIR/DeepSeek Harness.app"; mkdir -p "$APPDIR/DeepSeek Harness.app/Contents"; echo old > "$APPDIR/DeepSeek Harness.app/Contents/old"
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy installs the artifact into the app path"  '[[ $out == *"DEPLOY OK: live"* ]] && [ -f "$APPDIR/DeepSeek Harness.app/Contents/MacOS/Sign" ] && [ ! -e "$APPDIR/DeepSeek Harness.app/Contents/old" ]'
check "deploy leaves no .new or .old bundle"            '[ ! -e "$APPDIR/DeepSeek Harness.app.new" ] && [ ! -e "$APPDIR/DeepSeek Harness.app.old" ]'
check "deploy stamps the deployed sha"                  '[ "$(cut -d" " -f1 "$LIVE/logs/rollout/deployed")" = "$FORKSHA" ]'
check "deploy runs the post-deploy hook"                '[ "$(cat "$LIVE/hook.out" 2>/dev/null)" = hook-ran ]'
check "deploy sets up the live profile before the hook"  '[ "$(tail -n 1 "$SB/setup.calls" 2>/dev/null)" = "$LIVE $SB/fork 1" ]'
rm -f "$LIVE/hook.out"
out=$(ROLLOUT_PROFILE_SETUP=false "$S/deploy.sh" --no-relaunch 2>&1)
check "a failed profile setup stops deploy before the hook" '[[ $out == *"DEPLOY FAILED: profile setup failed"* ]] && [ ! -e "$LIVE/hook.out" ]'
printf '#!/bin/sh\necho "$*" > "%s/open.args"\n(env | grep -E "^(DSH|ELECTRON)_" || echo none) > "%s/open.env"\n' "$SB" "$SB" > "$FAKEBIN/open"; chmod +x "$FAKEBIN/open"
out=$(BASH_ENV= PATH="$FAKEBIN:$PATH" ELECTRON_RUN_AS_NODE=1 DSH_HOME=/should/not/leak "$S/deploy.sh" 2>&1)
check "deploy relaunches the app" '[[ $out == *"DEPLOY OK: live"* && "$(cat "$SB/open.args" 2>/dev/null)" == "$APPDIR/DeepSeek Harness.app" ]]'
check "the relaunch carries no DSH_* or ELECTRON_* variable" '[ "$(cat "$SB/open.env" 2>/dev/null)" = none ]'
rm -f "$FAKEBIN/open" "$SB/open.args" "$SB/open.env"

# other DSH Desktops on the live home (a fake bundle with the DSH identifier, not $APP, not legacy)
mkdesk "$SB/Other.app" com.deepseek.benchharness.dev.x
"$SB/Other.app/Contents/MacOS/DeepSeek Harness" 120 & opid=$!
mkdesk "$SB/Foreign.app" com.example.other
"$SB/Foreign.app/Contents/MacOS/DeepSeek Harness" 120 & fpid=$!; sleep 0.5
mkdir -p "$APPDIR/DeepSeek Harness.app/Contents"; echo keep > "$APPDIR/DeepSeek Harness.app/Contents/marker"
out=$("$S/deploy.sh" --dry-run 2>&1)
check "deploy dry run warns about another running DSH Desktop" '[[ $out == *"WARNING: another DSH Desktop runs: $SB/Other.app"* && $out != *Foreign* ]]'
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses while another DSH Desktop still runs, installing nothing" \
  '[[ $out == *"DEPLOY FAILED: another DSH Desktop still runs: $SB/Other.app (pid $opid) — quit it, then deploy again; nothing installed"* ]] && [ -f "$APPDIR/DeepSeek Harness.app/Contents/marker" ] && kill -0 '"$opid"
check "state: other_desktops names the other DSH Desktop only" '[ "$(st other_desktops)" = "$SB/Other.app" ]'
out=$(ROLLOUT_LEGACY_APP="$SB/Other.app" st other_desktops)
check "state: the legacy app is not an other desktop"    '[ -z "$out" ]'
# Several desktop processes at once (a Desktop's Host child runs the same executable): the
# refusal must still name one, not die on a broken pipe.
mkdesk "$SB/Other2.app" com.deepseek.benchharness
"$SB/Other.app/Contents/MacOS/DeepSeek Harness" 120 & opid2=$!
"$SB/Other2.app/Contents/MacOS/DeepSeek Harness" 120 & opid3=$!; sleep 0.5
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses with the named message while several DSH Desktop processes run" \
  '[[ $out == *"DEPLOY FAILED: another DSH Desktop still runs: "*"quit it, then deploy again; nothing installed"* && $out != *"exited 141"* ]] && [ -f "$APPDIR/DeepSeek Harness.app/Contents/marker" ]'
out=$(ROLLOUT_APP="$SB/NoApp.app" "$S/deploy.sh" --no-relaunch 2>&1)
check "cutover refuses with the named message while several DSH Desktop processes run" \
  '[[ $out == *"DEPLOY FAILED: a DSH Desktop runs ("*") but ROLLOUT_LEGACY_APP does not name it"* && $out != *"exited 141"* ]]'
kill "$opid2" "$opid3"; wait "$opid2" "$opid3" 2>/dev/null
kill "$opid"; wait "$opid" 2>/dev/null
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy ignores a running bundle with another identifier" '[[ $out == *"DEPLOY OK: live"* ]] && kill -0 '"$fpid"
out=$("$S/state.sh")
check "state: no other desktop prints an empty other_desktops" '[[ $out == *$'"'"'\nother_desktops=\n'"'"'* ]]'
"$SB/Other.app/Contents/MacOS/DeepSeek Harness" 120 & opid=$!; sleep 0.5
out=$(ROLLOUT_APP="$SB/NoApp.app" "$S/deploy.sh" --no-relaunch 2>&1)
check "cutover refuses a running DSH Desktop that ROLLOUT_LEGACY_APP does not name" \
  '[[ $out == *"DEPLOY FAILED: a DSH Desktop runs ($SB/Other.app) but ROLLOUT_LEGACY_APP does not name it — set it in the config"* ]] && [ ! -e "$SB/NoApp.app" ]'
out=$(ROLLOUT_APP="$SB/NoApp.app" "$S/deploy.sh" --dry-run 2>&1)
check "the cutover dry run warns about it" '[[ $out == *"WARNING: a DSH Desktop runs ($SB/Other.app) but ROLLOUT_LEGACY_APP"* ]]'
out=$(ROLLOUT_APP="$SB/NoApp.app" ROLLOUT_LEGACY_APP="$SB/Other.app" "$S/deploy.sh" --dry-run 2>&1)
check "the cutover accepts the running desktop when ROLLOUT_LEGACY_APP names it" '[[ $out != *"does not name it"* && $out == *"quit"*"$SB/Other.app"* ]]'
kill "$opid" "$fpid"; wait "$opid" "$fpid" 2>/dev/null
out=$(ROLLOUT_APP="$SB/NoApp.app" "$S/deploy.sh" --dry-run 2>&1)
check "the cutover without a running desktop needs no legacy app" '[[ $out != *"does not name it"* && $out == *"DEPLOY OK: dry run" ]]'

# ── state.sh ──
check "state: rollout once config, develop and the app exist" '[ "$(st mode)" = rollout ]'
check "state: the verified stamp matches develop"       '[ "$(st verified_is_head)" = yes ]'
out=$(ROLLOUT_APP="$SB/NoApp.app" st mode)
check "state: no live bundle yet is cutover"            '[ "$out" = cutover ]'
out=$(ROLLOUT_CONFIG="$SB/none.sh" ROLLOUT_FORK= st mode)
check "state: no fork configured is initial-setup"      '[ "$out" = initial-setup ]'
out=$(ROLLOUT_BRANCH=nope st mode)
check "state: no integration branch is initial-setup"   '[ "$out" = initial-setup ]'
check "state: ends with the result line"                '[[ $("$S/state.sh" | tail -1) == "STATE OK: mode="* ]]'
noagent() { env -u CLAUDECODE -u DSH_SESSION_ID -u DSH_SHELL $(env | grep -o '^CODEX_[A-Za-z_]*' | sed 's/^/-u /') "$@"; }
h() { noagent "$@" "$S/state.sh" | grep "^harness=" | cut -d= -f2; }
check "state: harness from DSH_SESSION_ID"              '[ "$(h DSH_SESSION_ID=x)" = dsh ]'
check "state: harness from CLAUDECODE"                  '[ "$(h CLAUDECODE=1)" = claude-code ]'
check "state: harness from a CODEX_ variable"           '[ "$(h CODEX_SANDBOX=seatbelt)" = codex ]'
check "state: no marker is unknown"                     '[ "$(h)" = unknown ]'
check "state: inside_dsh under DSH_SHELL=1"             '[ "$(noagent DSH_SHELL=1 "$S/state.sh" | grep ^inside_dsh= | cut -d= -f2)" = yes ]'
# The sandbox live home has sessions (the deploy section's open turn); zstd is absent from this PATH.
out=$($NOZSTD "$S/state.sh" 2>&1)
check "state: unreadable turns print open_turns=unknown" '[[ $out == *"open_turns=unknown"* && $out != *"open_turns=1"* ]]'
check "state: unreadable turns still end with the result line" '[[ $(echo "$out" | tail -1) == "STATE OK: mode="* ]]'

# ── --help prints exactly the header comment ──
for sc in merge verify deploy state; do
  out=$("$S/$sc.sh" --help 2>&1)
  check "$sc.sh --help: the whole header comment, nothing after it" \
    '[[ $(echo "$out" | tail -1) == "#"* && $(echo "$out" | head -1) == "# "* && $(echo "$out" | grep -vc "^#") -eq 0 && $(echo "$out" | wc -l) -eq $(awk "NR>1 && /^[^#]/{print NR-2; exit}" "$S/$sc.sh") ]]'
done

# ── skills/install.sh ──
I="$HERE/../../install.sh"
out=$(HOME="$SB/h" bash "$I" --target agents dz-dsh-rollout 2>&1)
check "install.sh --target agents copies into ~/.agents/skills" '[ -x "$SB/h/.agents/skills/dz-dsh-rollout/scripts/state.sh" ]'
out=$(HOME="$SB/h" bash "$I" --target claude dz-dsh-rollout 2>&1)
check "install.sh --target claude copies into ~/.claude/skills" '[ -f "$SB/h/.claude/skills/dz-dsh-rollout/SKILL.md" ]'
out=$(HOME="$SB/h" CODEX_HOME= bash "$I" --target codex dz-dsh-rollout 2>&1)
check "install.sh --target codex copies into ~/.codex/skills"   '[ -f "$SB/h/.codex/skills/dz-dsh-rollout/SKILL.md" ]'
out=$(HOME="$SB/h" bash "$I" --target agents dz-dsh-rollout 2>&1)
check "install.sh keeps an installed copy without --force"      '[[ $out == *"skip dz-dsh-rollout"* ]]'
out=$(HOME="$SB/h" bash "$I" --target agents --force dz-dsh-rollout 2>&1)
check "install.sh --force backs up the old copy"                '[ -n "$(ls "$SB/h/.agents/backups/skills" 2>/dev/null)" ]'
out=$(HOME="$SB/h" bash "$I" --target nope 2>&1)
check "install.sh rejects an unknown target"                    '[[ $out == *"--target must be agents, claude or codex"* ]]'

# ── summary ──
echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
