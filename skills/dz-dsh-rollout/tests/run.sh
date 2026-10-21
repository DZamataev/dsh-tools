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
EOF
export ROLLOUT_CONFIG="$SB/cfg/config.sh" ROLLOUT_NO_NOTIFY=1 ROLLOUT_STOP_TIMEOUT=5
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
mkbundle "$TEST/artifacts/abc123/DeepSeek Harness.app"
"$TEST/artifacts/abc123/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" 120 & tpid=$!; sleep 0.5
check "test_instance_pids: a process under the artifacts dir" '[ "$(lib test_instance_pids)" = "$tpid" ]'
check "test_instance_sha: names the artifact sha"        '[ "$(lib test_instance_sha)" = abc123 ]'
lib stop_test_instance >/dev/null 2>&1
check "stop_test_instance: stops it"                     '! kill -0 '"$tpid"' 2>/dev/null'
wait "$tpid" 2>/dev/null
rm -rf "$TEST/artifacts/abc123"

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

# ── summary ──
echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
