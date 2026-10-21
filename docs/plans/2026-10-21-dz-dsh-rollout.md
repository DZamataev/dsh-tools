# dz-dsh-rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `dz-dsh-rollout` skill in `~/dev/dsh-tools` whose `merge.sh`, `verify.sh`, `deploy.sh` and `state.sh` carry the operator's DSH fork from feature worktrees through an isolated test instance (`~/.dsh-dev`) into `~/Applications/DeepSeek Harness.app`, plus the one-time setup and cutover of live onto it.

**Architecture:** Bash scripts sharing `lib.sh`, configured by `~/.config/dz-dsh-rollout/config.sh`. The fork checkout only merges; a detached build worktree tests, packages and Developer ID-signs the exact sha into `~/.dsh-dev/artifacts/<sha>/`; the test instance runs that artifact; deploy installs those bytes. A mktemp bench (`tests/run.sh`) covers everything except the real build and the real app.

**Tech Stack:** bash 3.2 (macOS `/bin/bash`), git, pnpm 11 / vitest 4 (in the DSH checkout), `codesign`, `ditto`, `open`, `osascript`, `zstd`, Node (JSON handling).

**Spec:** `~/dev/dsh-tools/docs/specs/2026-10-21-dz-dsh-rollout-design.md`

## Global Constraints

- Scripts run under macOS `/bin/bash` 3.2: no associative arrays, no `mapfile`, no `${var,,}`; expand possibly-empty arrays as `${a[@]+"${a[@]}"}`.
- Every script ends with exactly one result line `MERGE|VERIFY|DEPLOY|STATE OK: …` or `… FAILED: …` and posts a macOS notification (suppressed by `ROLLOUT_NO_NOTIFY=1`).
- Processes are found by executable path (`ps -axo pid=,comm=`), never `pgrep -f`.
- `deploy.sh` without `--dry-run` refuses when `DSH_SESSION_ID` is set or `DSH_SHELL=1`, printing the absolute command.
- Push only on the operator's explicit word; never force.
- Nothing is built in `~/dev/deepseek-harness` (live runs its `lib/` until cutover).
- Worktree paths: only `~/dev/deepseek-harness-wt/rollout-build` is approved for creation.
- Test home seed never copies `.credentials.yaml`, `mobile-access/`, `sessions/`, `attachments/`, `logs/`, `.anonymous-user-id`.
- Sign identity: `Developer ID Application: Denis Zamataev (68QJJA7HK9)`, `codesign --force --deep`, no hardened runtime, no notarization.
- Bundle id `com.deepseek.harness`; bundle name `DeepSeek Harness.app`.
- Tasks 8–10 change the operator's machine state: each step marked **[operator yes]** waits for the operator's explicit yes in chat.

## File Structure

```
dsh-tools/
  README.md                                   what the repo holds, how to install
  .gitignore                                  node_modules/, .DS_Store
  skills/install.sh                           copies skills into agents|claude|codex skill roots
  skills/dz-dsh-rollout/SKILL.md              agent procedure, rules, pitfalls
  skills/dz-dsh-rollout/references/setup.md   initial setup and cutover
  skills/dz-dsh-rollout/templates/config.sh   config template
  skills/dz-dsh-rollout/scripts/lib.sh        config, result line, processes, turns, seed, sign, install
  skills/dz-dsh-rollout/scripts/merge.sh      step 1
  skills/dz-dsh-rollout/scripts/verify.sh     step 2
  skills/dz-dsh-rollout/scripts/deploy.sh     step 3
  skills/dz-dsh-rollout/scripts/state.sh      read-only status
  skills/dz-dsh-rollout/tests/run.sh          bench
  plugins/provider-limits/                    copied from ~/dev/dsh-plugins/provider-limits
  plugins/install.sh                          relinks profile link plugins, reinstalls with bundled pnpm
  plugins/tests/run.sh                        bench for plugins/install.sh
```

---

### Task 1: Repository scaffold, `lib.sh`, config template, bench core

**Files:**
- Create: `~/dev/dsh-tools/README.md`, `~/dev/dsh-tools/.gitignore`
- Create: `skills/dz-dsh-rollout/scripts/lib.sh`
- Create: `skills/dz-dsh-rollout/templates/config.sh`
- Test: `skills/dz-dsh-rollout/tests/run.sh`

**Interfaces:**
- Produces (sourced by every script; variables): `FORK BRANCH WT_ROOT BUILD_WT UPSTREAM PUSH_REMOTE LIVE_HOME TEST_HOME APP SIGN_IDENTITY LEGACY_APP POST_DEPLOY KEEP_ARTIFACTS TURN_WINDOW_HOURS BUNDLE_ID STATE_DIR VERIFIED DEPLOYED ARTIFACTS APP_NAME SCRIPT_NAME TAG`.
- Produces (functions):
  - `step <text>`, `notify <text>`, `fail <text>` (exit 1), `ok <text>`;
  - `require_config`, `require_build_config`, `require_branch_clean <checkout>`, `inside_dsh` (status);
  - `wt_branches` → lines `<path>\t<branch>`;
  - `dsh_env_unset` → words `-u NAME`;
  - `proc_paths` → `<pid> <exe>`;
  - `bundle_pids <bundle>`, `test_instance_pids`, `test_instance_main_pids`, `test_instance_sha`;
  - `stop_test_instance`, `quit_bundle <bundle>`;
  - `live_turns <home>` → `<home>: <session id> since <time>`;
  - `seed_test_home <live home> <test home>`;
  - `sign_bundle <bundle> <identity>` (status), `requirement_ok <bundle> <identity>` (status);
  - `install_bundle <src> <dst>`, `prune_artifacts [<sha to keep>]`.
- Bench helpers used by later tasks: `check <name> <expr>`, `lib <fn> [args]`, `session <home> <id> <event types…>`, `mkbundle <bundle path>`, variables `S SB WT LIVE TEST APPDIR`.

- [ ] **Step 1: Write `.gitignore` and `README.md`**

`.gitignore`:
```
node_modules/
.DS_Store
```

`README.md`:
```markdown
# dsh-tools

Denis Zamataev's tools for DeepSeek Harness (DSH).

- `skills/dz-dsh-rollout/`: roll the DSH fork out to the live Desktop (merge → verify → deploy). Install with `skills/install.sh --target agents` (DSH reads `~/.agents/skills`); `--target claude|codex` for those harnesses.
- `plugins/provider-limits/`: composer-dock chip with the remaining quota of TeamClaude, codex-lb and OpenCode Go routes. `plugins/install.sh` points a Desktop profile's link plugins here; rollout runs it after each deploy.

Design: `docs/specs/2026-10-21-dz-dsh-rollout-design.md`.
```

- [ ] **Step 2: Write the failing bench core** at `skills/dz-dsh-rollout/tests/run.sh` (mode 755)

```bash
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

# ── summary ──
echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
```

- [ ] **Step 3: Run the bench, expect failures**

Run: `bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh`
Expected: `FAIL` lines for every lib check (lib.sh missing), last line `N failed`.

- [ ] **Step 4: Write `skills/dz-dsh-rollout/scripts/lib.sh`**

```bash
# Shared by the dz-dsh-rollout scripts. Sourced, not executed.
# shellcheck shell=bash disable=SC2034  # config variables are read by the sourcing scripts
set -euo pipefail

# ── configuration ─────────────────────────────────────────────────────────────────────────────
# $ROLLOUT_CONFIG (default ~/.config/dz-dsh-rollout/config.sh; template ../templates/config.sh).
# Environment variables of the same name win over the file.
ROLLOUT_CONFIG=${ROLLOUT_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dz-dsh-rollout/config.sh}
_env_snapshot=$(declare -px 2>/dev/null | grep -E '^declare -x ROLLOUT_' || true)
# shellcheck source=/dev/null
[ -f "$ROLLOUT_CONFIG" ] && . "$ROLLOUT_CONFIG"
eval "$_env_snapshot"

FORK=${ROLLOUT_FORK:-}                                    # checkout holding the integration branch; git only
BRANCH=${ROLLOUT_BRANCH:-develop}                         # integration branch
WT_ROOT=${ROLLOUT_WT_ROOT:-}                              # feature worktrees (empty: every linked worktree)
BUILD_WT=${ROLLOUT_BUILD_WT:-}                            # detached build worktree, never merged or pushed
UPSTREAM=${ROLLOUT_UPSTREAM:-deepseek-ai/master}          # <remote>/<branch> for merge --upstream and test triage
PUSH_REMOTE=${ROLLOUT_PUSH_REMOTE:-origin}
# Not $DSH_HOME: an agent inside the test instance carries DSH_HOME=~/.dsh-dev.
LIVE_HOME=${ROLLOUT_LIVE_HOME:-$HOME/.dsh}
TEST_HOME=${ROLLOUT_TEST_HOME:-$HOME/.dsh-dev}
APP=${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}
SIGN_IDENTITY=${ROLLOUT_SIGN_IDENTITY:-}
LEGACY_APP=${ROLLOUT_LEGACY_APP:-}                        # pre-cutover dev build that deploy also quits
POST_DEPLOY=${ROLLOUT_POST_DEPLOY:-}
KEEP_ARTIFACTS=${ROLLOUT_KEEP_ARTIFACTS:-3}
TURN_WINDOW_HOURS=${ROLLOUT_TURN_WINDOW_HOURS:-12}        # an older open turn is a crash leftover
BUNDLE_ID=${ROLLOUT_BUNDLE_ID:-com.deepseek.harness}

STATE_DIR=$LIVE_HOME/logs/rollout
VERIFIED=$STATE_DIR/verified                              # "<sha> <date> tests=… app=… artifact=…"
DEPLOYED=$STATE_DIR/deployed                              # "<sha> <date>"
ARTIFACTS=$TEST_HOME/artifacts                            # <sha>/DeepSeek Harness.app
APP_NAME="DeepSeek Harness.app"

SCRIPT_NAME=$(basename "$0" .sh)
TAG=$(printf '%s' "$SCRIPT_NAME" | tr '[:lower:]' '[:upper:]')

step() { printf '\n== %s  [%s]\n' "$*" "$(date +%H:%M:%S)"; }
notify() {
  [ "${ROLLOUT_NO_NOTIFY:-0}" = 1 ] && return 0
  command -v osascript >/dev/null && osascript -e "display notification \"${1//\"/\'}\" with title \"DSH $SCRIPT_NAME\"" >/dev/null 2>&1 || true
}
fail() {
  trap - EXIT
  echo "$TAG FAILED: $*"
  notify "failed: $*"
  exit 1
}
ok() {
  trap - EXIT
  echo
  echo "$TAG OK: $*"
  notify "OK: $*"
}
# shellcheck disable=SC2154  # rc is assigned inside the trap body
trap 'rc=$?; [ $rc -eq 0 ] || { echo "$TAG FAILED: line $LINENO exited $rc"; notify "failed (line $LINENO)"; }' EXIT

require_config() {
  [ -n "$FORK" ] || fail "ROLLOUT_FORK is not set — copy templates/config.sh to $ROLLOUT_CONFIG and fill it in"
  [ -e "$FORK/.git" ] || fail "ROLLOUT_FORK is not a git checkout: $FORK"
  mkdir -p "$STATE_DIR"
}
require_build_config() {
  [ -n "$BUILD_WT" ] || fail "ROLLOUT_BUILD_WT is not set"
  [ -n "$SIGN_IDENTITY" ] || fail "ROLLOUT_SIGN_IDENTITY is not set"
}

# A DSH agent's tools carry DSH_SESSION_ID; DSH's terminals export DSH_SHELL=1 to everything started
# in them. Deploy quits that DSH, killing the caller.
inside_dsh() { [ -n "${DSH_SESSION_ID:-}" ] || [ "${DSH_SHELL:-}" = 1 ]; }

require_branch_clean() {  # $1 = checkout
  local dirty
  [ "$(git -C "$1" branch --show-current)" = "$BRANCH" ] || fail "$1 is not on $BRANCH"
  dirty=$(git -C "$1" status --porcelain --untracked-files=no)
  [ -z "$dirty" ] || fail "$1 has uncommitted changes: $(echo "$dirty" | tr '\n' ' ')"
}

# "<path>\t<branch>" for each feature worktree of $FORK (branch empty when detached); never the
# main checkout or the build worktree.
wt_branches() {
  local main_wt; main_wt=$(git -C "$FORK" rev-parse --show-toplevel)
  git -C "$FORK" worktree list --porcelain | awk '
    /^worktree /{p=substr($0,10); b=""} /^branch /{b=substr($0,19)} /^$/{if(p!="") print p "\t" b; p=""}
    END{if(p!="") print p "\t" b}' |
  while IFS=$'\t' read -r path branch; do
    [ "$path" = "$main_wt" ] && continue
    [ -n "$BUILD_WT" ] && [ "$path" = "$BUILD_WT" ] && continue
    if [ -n "$WT_ROOT" ]; then case $path in "$WT_ROOT"/*) ;; *) continue ;; esac; fi
    printf '%s\t%s\n' "$path" "$branch"
  done
}

# `env` arguments removing every DSH_* and ELECTRON_* variable: an agent inside live DSH carries its
# session, profile and home, which must reach neither builds nor the test instance.
dsh_env_unset() { env | sed -n -E 's/^((DSH|ELECTRON)_[A-Za-z0-9_]*)=.*/-u \1/p'; }

# ── processes ─────────────────────────────────────────────────────────────────────────────────
# "<pid> <executable path>": `comm` is the executable path on macOS, while argv can be withheld.
proc_paths() { ps -axo pid=,comm= | sed -E 's/^ *([0-9]+) +/\1 /'; }
bundle_pids() {  # $1 = bundle; processes whose executable sits directly in <bundle>/Contents/MacOS/
  [ -n "${1:-}" ] || return 0
  proc_paths | awk -v dir="$1/Contents/MacOS/" '{
    pid = $1; exe = substr($0, length($1) + 2)
    if (index(exe, dir) == 1 && index(substr(exe, length(dir) + 1), "/") == 0) print pid }'
}
test_instance_pids() {  # processes running $ARTIFACTS/<sha>/<name>.app/Contents/MacOS/<exe>
  proc_paths | awk -v root="$ARTIFACTS/" '{
    pid = $1; exe = substr($0, length($1) + 2)
    if (index(exe, root) == 1 && substr(exe, length(root) + 1) ~ /^[^\/]+\/[^\/]+\.app\/Contents\/MacOS\/[^\/]+$/) print pid }'
}
test_instance_main_pids() {  # the Electron main process: its parent is not a test-instance process
  local all p pp
  all=" $(test_instance_pids | tr '\n' ' ') "
  for p in $all; do
    pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [[ "$all" == *" $pp "* ]] || echo "$p"
  done
}
test_instance_sha() {
  local pid exe
  pid=$(test_instance_pids | head -1)
  [ -n "$pid" ] || return 0
  exe=$(ps -o comm= -p "$pid" 2>/dev/null) || return 0
  exe=${exe#"$ARTIFACTS/"}
  echo "${exe%%/*}"
}
stop_test_instance() {
  local pids
  pids=$(test_instance_main_pids)
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086  # one pid per word
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 "${ROLLOUT_STOP_TIMEOUT:-30}"); do [ -n "$(test_instance_pids)" ] || return 0; sleep 1; done
  fail "test instance did not quit within ${ROLLOUT_STOP_TIMEOUT:-30} s (a quit confirmation may be open in its window)"
}
# The ordinary quit (as ⌘Q): DSH asks for confirmation itself while tasks run. Addressed by path;
# stop the test instance first, it shares the bundle id.
quit_bundle() {  # $1 = bundle
  [ -n "${1:-}" ] || return 0
  [ -n "$(bundle_pids "$1")" ] || return 0
  osascript -e "tell application \"$1\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 "${ROLLOUT_QUIT_TIMEOUT:-120}"); do [ -n "$(bundle_pids "$1")" ] || return 0; sleep 1; done
  fail "$1 is still running after ${ROLLOUT_QUIT_TIMEOUT:-120} s (quit cancelled in its dialog?) — nothing installed"
}

# ── turns ─────────────────────────────────────────────────────────────────────────────────────
# Open agent turns in a DSH home: a session log changed within $TURN_WINDOW_HOURS whose last
# turn event is turn/start. Prints "<home>: <session id> since <time>".
live_turns() {  # $1 = DSH home
  local home=$1 f last t
  [ -d "$home/sessions" ] || return 0
  while IFS= read -r -d '' f; do
    last=$({ zstd -dcq "$f" 2>/dev/null || true; } | { grep -E '^\{"type":"turn/(start|end)"' || true; } | tail -1)
    case $last in
      '{"type":"turn/start"'*)
        t=$(printf '%s' "$last" | sed -E 's/.*"time":([0-9]+).*/\1/')
        echo "$home: $(basename "$(dirname "$f")") since $(date -r $((t / 1000)) '+%F %T')" ;;
    esac
  done < <(find "$home/sessions" -name 'session.v*.jsonl.zstd' -mmin -$((TURN_WINDOW_HOURS * 60)) -print0 2>/dev/null)
  return 0
}

# ── test home seed ────────────────────────────────────────────────────────────────────────────
# Shareable state only: static API keys, machine MCP servers, the project list and the desktop
# profile (patch, manifest, lockfile, node_modules whose relative links resolve at the same depth).
# Never the per-home browser-session secret, sessions, attachments, logs or mobile access.
seed_test_home() {  # $1 = live home, $2 = test home
  local src=$1 dst=$2 f
  mkdir -p "$dst/profiles/desktop" "$dst/storages"
  chmod 700 "$dst"
  if [ -f "$src/.env" ]; then cp "$src/.env" "$dst/.env"; chmod 600 "$dst/.env"; fi
  [ ! -f "$src/cordis.patch.yml" ] || cp "$src/cordis.patch.yml" "$dst/cordis.patch.yml"
  [ ! -f "$src/storages/workspace.json" ] || cp "$src/storages/workspace.json" "$dst/storages/workspace.json"
  for f in cordis.patch.yml package.json pnpm-lock.yaml pnpm-workspace.yaml; do
    [ ! -f "$src/profiles/desktop/$f" ] || cp "$src/profiles/desktop/$f" "$dst/profiles/desktop/$f"
  done
  if [ -d "$src/profiles/desktop/node_modules" ]; then
    rm -rf "$dst/profiles/desktop/node_modules"
    cp -a "$src/profiles/desktop/node_modules" "$dst/profiles/desktop/node_modules"
  fi
}

# ── signing and install ───────────────────────────────────────────────────────────────────────
# A certificate identity gives a designated requirement (bundle id + team) that survives rebuilds,
# so TCC grants stay; ad-hoc ("-") ties them to the cdhash. No hardened runtime: Electron's JIT
# helpers would need entitlements, and a local build needs no notarization.
sign_bundle() {  # $1 = bundle, $2 = identity
  codesign --force --deep --timestamp=none --sign "$2" "$1" || return 1
  codesign --verify --deep --strict "$1"
}
requirement_ok() {  # $1 = bundle, $2 = identity
  local req team
  [ "$2" = - ] && return 0
  req=$(codesign -d -r- "$1" 2>&1) || return 1
  team=$(printf '%s' "$2" | sed -nE 's/.*\(([A-Z0-9]+)\)$/\1/p')
  [ -n "$team" ] && [[ "$req" == *"identifier \"$BUNDLE_ID\""* ]] && [[ "$req" == *"$team"* ]]
}
install_bundle() {  # $1 = source bundle, $2 = destination bundle
  local src=$1 dst=$2
  rm -rf "$dst.new" "$dst.old"
  mkdir -p "$(dirname "$dst")"
  ditto "$src" "$dst.new" || fail "could not copy $src to $dst.new"
  if [ -e "$dst" ]; then
    mv "$dst" "$dst.old" || { rm -rf "$dst.new"; fail "could not move $dst aside"; }
  fi
  if ! mv "$dst.new" "$dst"; then
    [ ! -e "$dst.old" ] || mv "$dst.old" "$dst"
    fail "could not install $dst (previous bundle restored)"
  fi
  rm -rf "$dst.old"
}
prune_artifacts() {  # keep the newest $KEEP_ARTIFACTS, the deployed sha and $1
  local deployed d n=0
  deployed=$(cut -d' ' -f1 "$DEPLOYED" 2>/dev/null || true)
  [ -d "$ARTIFACTS" ] || return 0
  for d in $(ls -1t "$ARTIFACTS"); do
    n=$((n + 1))
    if [ "$n" -le "$KEEP_ARTIFACTS" ] || [ "$d" = "$deployed" ] || [ "$d" = "${1:-}" ]; then continue; fi
    rm -rf "${ARTIFACTS:?}/$d"
  done
}
```

- [ ] **Step 5: Write `skills/dz-dsh-rollout/templates/config.sh`**

```bash
# dz-dsh-rollout configuration. Copy to ~/.config/dz-dsh-rollout/config.sh and edit.
# Every value can also be set as an environment variable of the same name (it wins over this file).
# shellcheck shell=bash disable=SC2034

# Checkout holding the integration branch. Merges only: nothing is built here.
ROLLOUT_FORK=$HOME/dev/deepseek-harness
ROLLOUT_BRANCH=develop

# Feature worktrees merged into the branch (empty: every linked worktree of the fork).
ROLLOUT_WT_ROOT=$HOME/dev/deepseek-harness-wt

# Detached worktree where verify.sh installs, tests, packages and signs the exact sha.
ROLLOUT_BUILD_WT=$HOME/dev/deepseek-harness-wt/rollout-build

# <remote>/<branch> that `merge.sh --upstream` merges and failing tests are compared against.
ROLLOUT_UPSTREAM=deepseek-ai/master
ROLLOUT_PUSH_REMOTE=origin

# Live and test DSH homes; the live app bundle.
ROLLOUT_LIVE_HOME=$HOME/.dsh
ROLLOUT_TEST_HOME=$HOME/.dsh-dev
ROLLOUT_APP="$HOME/Applications/DeepSeek Harness.app"

# Code-signing identity (security find-identity -v -p codesigning). A certificate keeps TCC grants
# across rebuilds; "-" (ad-hoc) loses them on every build.
ROLLOUT_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# Dev build live still runs before the first deploy (cutover); deploy quits it too. Empty afterwards.
ROLLOUT_LEGACY_APP=

# Command run after the bundle is installed, while every window is closed.
# Gets ROLLOUT_LIVE_HOME, ROLLOUT_TEST_HOME and ROLLOUT_APP in its environment.
ROLLOUT_POST_DEPLOY="$HOME/dev/dsh-tools/plugins/install.sh"

# Verified artifacts kept besides the deployed one.
# ROLLOUT_KEEP_ARTIFACTS=3
```

- [ ] **Step 6: Run the bench, expect all lib checks to pass**

Run: `chmod +x ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh && bash -n ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/lib.sh && bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh`
Expected: every line `ok …`, last line `all passed`.

- [ ] **Step 7: Commit**

```bash
cd ~/dev/dsh-tools && git add README.md .gitignore skills/dz-dsh-rollout && git commit -m "feat(dz-dsh-rollout): lib, config template, bench core"
```

---

### Task 2: `merge.sh`

**Files:**
- Create: `skills/dz-dsh-rollout/scripts/merge.sh` (mode 755)
- Test: `skills/dz-dsh-rollout/tests/run.sh` (insert before `# ── summary ──`)

**Interfaces:**
- Consumes: `require_config`, `require_branch_clean`, `wt_branches`, `step`, `fail`, `ok`, `FORK BRANCH UPSTREAM`.
- Produces: CLI `merge.sh [--dry-run] [--upstream]`. Output lines `to merge: <branch> (+N; M over <upstream>)`, `up to date: <branch>`, result line.

- [ ] **Step 1: Add the failing bench section**

```bash
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
```

- [ ] **Step 2: Run the bench, expect the merge checks to fail**

Run: `bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | grep -E '^FAIL|failed|passed'`
Expected: `FAIL merge …` lines.

- [ ] **Step 3: Write `scripts/merge.sh`**

```bash
#!/usr/bin/env bash
# Step 1/3. Merge into the fork's integration branch: optionally the upstream branch first, then
# every feature-worktree branch with commits ahead of it. Git only: nothing is built in the fork
# checkout (a pre-cutover live Desktop runs from it).
#
#   merge.sh --dry-run      list what would be merged
#   merge.sh                merge the worktree branches
#   merge.sh --upstream     fetch the upstream remote first and merge its branch, then the worktrees
#
# A conflict aborts that merge, keeps the merges before it and stops: resolve it by hand in the
# fork (git merge <branch>), commit, rerun.
. "$(dirname "$0")/lib.sh"

dry_run=false upstream=false
for arg in "$@"; do
  case $arg in
    --dry-run) dry_run=true ;;
    --upstream) upstream=true ;;
    -h|--help) trap - EXIT; sed -n '2,11p' "$0"; exit 0 ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

step "preconditions"
require_config
require_branch_clean "$FORK"

if $upstream; then
  step "$UPSTREAM → $BRANCH"
  git -C "$FORK" fetch -q "${UPSTREAM%%/*}" || fail "git fetch ${UPSTREAM%%/*} failed"
  n=$(git -C "$FORK" rev-list --count "$BRANCH..$UPSTREAM")
  echo "$UPSTREAM is $n commit(s) ahead of $BRANCH"
  if [ "$n" -gt 0 ] && ! $dry_run; then
    if ! git -C "$FORK" merge --no-ff --no-edit -m "Merge $UPSTREAM into $BRANCH" "$UPSTREAM"; then
      git -C "$FORK" merge --abort || true
      fail "merge conflict: $UPSTREAM into $BRANCH (aborted; resolve by hand in $FORK)"
    fi
  fi
fi

step "worktree branches → $BRANCH"
to_merge=()
while IFS=$'\t' read -r path branch; do
  [ -n "$branch" ] || { echo "skip $path: detached HEAD"; continue; }
  [ "$branch" = "$BRANCH" ] && continue
  [ -d "$path" ] || { echo "skip $branch: worktree dir $path is gone (prunable)"; continue; }
  ahead=$(git -C "$FORK" rev-list --count "$BRANCH..$branch")
  if [ "$ahead" -eq 0 ]; then echo "up to date: $branch"; continue; fi
  if [ -n "$(git -C "$path" status --porcelain --untracked-files=no)" ]; then
    echo "WARNING: $branch has uncommitted changes in $path — only its commits are merged"
  fi
  # A branch cut from a newer upstream carries upstream in its +N: then merge --upstream first.
  own=$(git -C "$FORK" rev-list --count "$UPSTREAM..$branch" 2>/dev/null || echo '?')
  echo "to merge: $branch (+$ahead; $own over $UPSTREAM)"
  to_merge+=("$branch")
done < <(wt_branches)

if $dry_run; then
  ok "dry run, nothing merged; ${#to_merge[@]} branch(es) to merge: ${to_merge[*]:-none}"
  exit 0
fi
for branch in ${to_merge[@]+"${to_merge[@]}"}; do
  if ! git -C "$FORK" merge --no-ff --no-edit -m "merge: $branch into $BRANCH" "$branch"; then
    git -C "$FORK" merge --abort || true
    fail "merge conflict: $branch into $BRANCH (aborted; earlier merges kept)"
  fi
  echo "merged: $branch"
done

ok "$BRANCH at $(git -C "$FORK" rev-parse --short HEAD), merged ${#to_merge[@]} branch(es): ${to_merge[*]:-none}; next: verify.sh"
```

- [ ] **Step 4: Run the bench, expect all checks to pass**

Run: `chmod +x ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/merge.sh && bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | tail -3`
Expected: `all passed`.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/dsh-tools && git add skills/dz-dsh-rollout && git commit -m "feat(dz-dsh-rollout): merge.sh"
```

---

### Task 3: `verify.sh`

**Files:**
- Create: `skills/dz-dsh-rollout/scripts/verify.sh` (mode 755)
- Test: `skills/dz-dsh-rollout/tests/run.sh` (insert before `# ── summary ──`)

**Interfaces:**
- Consumes: everything in `lib.sh` listed in Task 1.
- Produces:
  - CLI `verify.sh [--full|--no-tests] [--since REF] [--reseed] [--no-app] [--stop]`.
  - Writes `$VERIFIED` as `<sha> <YYYY-mm-dd HH:MM:SS> tests=<changed|full|none> app=<true|false> artifact=<path>`.
  - Artifact at `$ARTIFACTS/<sha>/DeepSeek Harness.app`.
  - Logs in `$STATE_DIR`: `verify-install.log`, `verify-typecheck.log`, `verify-tests-fork.log`/`.json`, `verify-tests-rerun.log`, `verify-tests-upstream.log`, `verify-package.log`, `verify-build-check.log`, `verify-sign.log`.

The bench covers `--stop` and the argument check; the build path is proven by the first real run (Task 9).

- [ ] **Step 1: Add the failing bench section**

```bash
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
```

- [ ] **Step 2: Run the bench, expect the verify checks to fail**

Run: `bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | grep -E '^FAIL|failed|passed'`
Expected: `FAIL verify …` lines.

- [ ] **Step 3: Write `scripts/verify.sh`**

```bash
#!/usr/bin/env bash
# Step 2/3. Verify the integration branch before it reaches live. Everything runs in the detached
# build worktree ($ROLLOUT_BUILD_WT) at the branch's sha; the fork checkout and the live app stay
# untouched, so an agent inside DSH may run this.
#   1. pnpm install --frozen-lockfile, build:native-system;
#   2. tests: typecheck, then vitest on what the diff since the deployed sha touches (--changed);
#      failing files are rerun alone, then on the upstream merge-base: only failures upstream lacks
#      count as ours;
#   3. package the unsigned macOS app, build:check, re-sign it with $ROLLOUT_SIGN_IDENTITY (TCC
#      grants survive rebuilds) and store it as $ROLLOUT_TEST_HOME/artifacts/<sha>/;
#   4. seed $ROLLOUT_TEST_HOME from the live home (no credentials, sessions or mobile access) and
#      start the artifact as the test instance (own DSH_HOME and Electron userData).
#
#   verify.sh               all of the above
#   verify.sh --full        the whole vitest suite instead of --changed
#   verify.sh --since REF   vitest --changed REF instead of the deployed sha
#   verify.sh --no-tests    skip 2                  verify.sh --no-app   build the artifact, start nothing
#   verify.sh --reseed      re-copy the seed into the test home before starting
#   verify.sh --stop        stop the test instance and exit
#
# On success writes "<sha> ..." to the verified stamp; deploy.sh installs only that sha's artifact.
. "$(dirname "$0")/lib.sh"

tests=changed app=true reseed=false since="" prev=""
for arg in "$@"; do
  if [ "$prev" = --since ]; then since=$arg; prev=""; continue; fi
  prev=$arg
  case $arg in
    --since) ;;
    --full) tests=full ;;
    --no-tests) tests=none ;;
    --no-app) app=false ;;
    --reseed) reseed=true ;;
    --stop) stop_test_instance; ok "test instance stopped"; exit 0 ;;
    -h|--help) trap - EXIT; sed -n '2,21p' "$0"; exit 0 ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

step "preconditions"
require_config
require_build_config
require_branch_clean "$FORK"
SHA=$(git -C "$FORK" rev-parse "$BRANCH")
SHORT=$(git -C "$FORK" rev-parse --short "$SHA")
UPBASE=$(git -C "$FORK" merge-base "$SHA" "$UPSTREAM" 2>/dev/null || true)
if [ -n "$since" ]; then BASE=$since
elif [ -s "$DEPLOYED" ]; then BASE=$(cut -d' ' -f1 "$DEPLOYED")
else BASE=$UPBASE; fi
[ -n "$BASE" ] || fail "no test base: nothing deployed and no merge-base with $UPSTREAM (pass --since)"
git -C "$FORK" cat-file -e "$BASE^{commit}" 2>/dev/null || fail "test base $BASE is not a commit in $FORK"
echo "$BRANCH $SHORT; tests changed since $(git -C "$FORK" rev-parse --short "$BASE") ($(git -C "$FORK" rev-list --count "$BASE..$SHA") commit(s))"

step "build worktree $BUILD_WT at $SHORT"
if [ ! -e "$BUILD_WT/.git" ]; then
  git -C "$FORK" worktree add -q --detach "$BUILD_WT" "$SHA" || fail "could not create $BUILD_WT"
else
  [ -z "$(git -C "$BUILD_WT" status --porcelain --untracked-files=no)" ] \
    || fail "$BUILD_WT has tracked changes — inspect them and reset the worktree by hand"
  git -C "$BUILD_WT" checkout -q --detach "$SHA" || fail "checkout of $SHORT in $BUILD_WT failed"
fi
# shellcheck disable=SC2046  # one -u NAME pair per word
bw() { (cd "$BUILD_WT" && env $(dsh_env_unset) "$@"); }
ILOG=$STATE_DIR/verify-install.log
install_deps() {
  bw pnpm install --frozen-lockfile >>"$ILOG" 2>&1 || fail "pnpm install failed — see $ILOG"
  bw pnpm run build:native-system >>"$ILOG" 2>&1 || fail "build:native-system failed — see $ILOG"
}
step "dependencies"
: >"$ILOG"
install_deps

# vitest JSON reports → one id per failure: "<file> > <test>", or "<file> (suite)" for a file that
# failed without a failed test (collection or hook error). Sorted, for comm.
failed_ids() {
  node -e '
    const fs = require("fs")
    for (const p of process.argv.slice(1)) {
      if (!fs.existsSync(p)) continue
      const r = JSON.parse(fs.readFileSync(p, "utf8"))
      for (const f of r.testResults || []) {
        if (f.status !== "failed") continue
        const bad = (f.assertionResults || []).filter(a => a.status === "failed")
        if (bad.length === 0) console.log(`${f.name} (suite)`)
        for (const a of bad) console.log(`${f.name} > ${a.fullName}`)
      }
    }' "$@" | sort -u
}
files_of() { sed -E 's/ (>|\().*$//' | sort -u; }

if [ "$tests" != none ]; then
  step "typecheck"
  bw pnpm run typecheck >"$STATE_DIR/verify-typecheck.log" 2>&1 || fail "typecheck failed — see $STATE_DIR/verify-typecheck.log"
  step "vitest ($tests)"
  FLOG=$STATE_DIR/verify-tests-fork.log FJSON=$STATE_DIR/verify-tests-fork.json
  rm -f "$FJSON" "$STATE_DIR"/verify-tests-rerun-*.json "$STATE_DIR"/verify-tests-upstream-*.json
  scope=(--changed "$BASE"); [ "$tests" = full ] && scope=()
  rc=0
  bw pnpm exec vitest run ${scope[@]+"${scope[@]}"} --passWithNoTests \
    --reporter=default --reporter=json --outputFile.json="$FJSON" >"$FLOG" 2>&1 || rc=$?
  grep -E '^ *(Test Files|Tests) ' "$FLOG" | tail -2 || true
  if [ $rc -ne 0 ]; then
    files=$(failed_ids "$FJSON" | files_of)
    [ -n "$files" ] || fail "vitest exited $rc without a failure list — see $FLOG"
    step "rerun $(echo "$files" | wc -l | tr -d ' ') failing file(s) one by one"
    RLOG=$STATE_DIR/verify-tests-rerun.log; : >"$RLOG"
    rjson=(); i=0
    for f in $files; do
      i=$((i + 1)); out=$STATE_DIR/verify-tests-rerun-$i.json
      bw pnpm exec vitest run "$f" --reporter=json --outputFile.json="$out" >>"$RLOG" 2>&1 || true
      rjson+=("$out")
    done
    fork_fail=$(failed_ids "${rjson[@]}")
    if [ -z "$fork_fail" ]; then
      echo "all pass alone: parallel-run flakes"
    else
      [ -n "$UPBASE" ] || fail "no merge-base with $UPSTREAM, so every failure is ours: $(echo "$fork_fail" | wc -l | tr -d ' ') — see $RLOG"
      step "rerun on upstream $(git -C "$FORK" rev-parse --short "$UPBASE")"
      ULOG=$STATE_DIR/verify-tests-upstream.log; : >"$ULOG"
      git -C "$BUILD_WT" checkout -q --detach "$UPBASE" || fail "checkout of the upstream base in $BUILD_WT failed"
      install_deps
      ujson=(); i=0
      for f in $(echo "$fork_fail" | files_of); do
        [ -f "$f" ] || continue   # a test file the fork added fails only on the fork
        i=$((i + 1)); out=$STATE_DIR/verify-tests-upstream-$i.json
        bw pnpm exec vitest run "$f" --reporter=json --outputFile.json="$out" >>"$ULOG" 2>&1 || true
        ujson+=("$out")
      done
      git -C "$BUILD_WT" checkout -q --detach "$SHA" || fail "checkout back to $SHORT in $BUILD_WT failed"
      install_deps
      up_fail=$(failed_ids ${ujson[@]+"${ujson[@]}"})
      ours=$(comm -23 <(echo "$fork_fail") <(echo "$up_fail") | sed '/^$/d')
      echo "failing on $BRANCH: $(echo "$fork_fail" | wc -l | tr -d ' '), also on upstream: $(comm -12 <(echo "$fork_fail") <(echo "$up_fail") | sed '/^$/d' | wc -l | tr -d ' ')"
      if [ -n "$ours" ]; then
        echo "NOT on upstream (ours):"; echo "$ours" | sed 's/^/  /'
        fail "$(echo "$ours" | wc -l | tr -d ' ') test failure(s) introduced by $BRANCH — logs: $RLOG, $ULOG"
      fi
      echo "every failure also fails on upstream — not ours"
    fi
  fi
fi

step "package ($SHORT)"
PLOG=$STATE_DIR/verify-package.log
TARGETS=$BUILD_WT/apps/desktop/.desktop-build/targets/mac-arm64
# Remove earlier outputs so the bundle found below is this run's.
[ ! -d "$TARGETS" ] || find "$TARGETS" -maxdepth 4 -type d -name "$APP_NAME" -prune -exec rm -rf {} +
bw pnpm run package:desktop:mac:arm64:unsigned --dir >"$PLOG" 2>&1 || fail "packaging failed — see $PLOG"
BUILT=$(find "$TARGETS" -maxdepth 4 -type d -name "$APP_NAME" 2>/dev/null | head -1)
[ -n "$BUILT" ] || fail "no $APP_NAME under $TARGETS after packaging — see $PLOG"
echo "built: $BUILT"
bw pnpm run build:check >"$STATE_DIR/verify-build-check.log" 2>&1 || fail "build:check failed — see $STATE_DIR/verify-build-check.log"

step "sign ($SIGN_IDENTITY)"
if [ "$(test_instance_sha)" = "$SHA" ]; then stop_test_instance; fi   # its bundle is replaced below
ART=$ARTIFACTS/$SHA/$APP_NAME
rm -rf "${ARTIFACTS:?}/$SHA"; mkdir -p "$ARTIFACTS/$SHA"
ditto "$BUILT" "$ART" || fail "could not copy $BUILT to $ART"
sign_bundle "$ART" "$SIGN_IDENTITY" >"$STATE_DIR/verify-sign.log" 2>&1 \
  || fail "signing or codesign --verify failed for $ART — see $STATE_DIR/verify-sign.log"
requirement_ok "$ART" "$SIGN_IDENTITY" \
  || fail "the designated requirement of $ART lacks identifier \"$BUNDLE_ID\" or the identity's team (codesign -d -r- \"$ART\")"
codesign -d -r- "$ART" 2>&1 | sed -n 's/^designated => /requirement: /p'
prune_artifacts "$SHA"

if $app; then
  step "seed $TEST_HOME"
  if $reseed || [ ! -f "$TEST_HOME/profiles/desktop/package.json" ]; then
    stop_test_instance   # it reads the files the seed replaces
    seed_test_home "$LIVE_HOME" "$TEST_HOME"
    echo "seeded .env, cordis.patch.yml, storages/workspace.json, profiles/desktop (patch, manifest, lockfile, node_modules); no credentials, sessions or mobile access"
  else
    echo "kept the existing seed (--reseed to refresh)"
  fi

  step "start test instance"
  stop_test_instance
  ILOG=$TEST_HOME/instance.log
  mkdir -p "$TEST_HOME/electron-user-data"
  : >"$ILOG"
  # LaunchServices makes launchd the parent (the instance outlives this shell) and passes no DSH_*
  # of the caller; env -u also keeps them out of open itself.
  # shellcheck disable=SC2046  # one -u NAME pair per word
  env $(dsh_env_unset) open -n -a "$ART" --env "DSH_HOME=$TEST_HOME" --stdout "$ILOG" --stderr "$ILOG" \
    --args "--user-data-dir=$TEST_HOME/electron-user-data" || fail "open of $ART failed"
  up=false
  for _ in $(seq 1 120); do
    sleep 1
    pids=$(test_instance_pids)
    [ -n "$pids" ] || continue
    for p in $pids; do
      if lsof -nP -a -p "$p" -iTCP -sTCP:LISTEN >/dev/null 2>&1; then up=true; fi
    done
    if $up; then break; fi
  done
  [ -n "$(test_instance_pids)" ] || fail "test instance exited (or never started) — see $ILOG"
  $up || fail "test instance runs but its Host is not listening after 120 s — see $ILOG"
  [ -e "$TEST_HOME/electron-user-data/SingletonLock" ] \
    || fail "the test instance ignored --user-data-dir and would share live's single-instance lock — see $ILOG"
  echo "test instance up: $ART; DSH_HOME=$TEST_HOME; userData $TEST_HOME/electron-user-data"
fi

echo "$SHA $(date '+%F %T') tests=$tests app=$app artifact=$ART" >"$VERIFIED"
ok "$BRANCH $SHORT verified (tests=$tests, app=$app). Check the test window, then: deploy.sh [--push]; stop it with verify.sh --stop"
```

- [ ] **Step 4: Run the bench, expect all checks to pass**

Run: `chmod +x ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/verify.sh && bash -n ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/verify.sh && bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | tail -3`
Expected: `all passed`.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/dsh-tools && git add skills/dz-dsh-rollout && git commit -m "feat(dz-dsh-rollout): verify.sh"
```

---

### Task 4: `deploy.sh`

**Files:**
- Create: `skills/dz-dsh-rollout/scripts/deploy.sh` (mode 755)
- Test: `skills/dz-dsh-rollout/tests/run.sh` (insert before `# ── summary ──`)

**Interfaces:**
- Consumes: `lib.sh` (Task 1); `verify.sh --stop` (Task 3); the `$VERIFIED` format from Task 3.
- Produces:
  - CLI `deploy.sh [--dry-run] [--push] [--unverified] [--ignore-live-turns] [--no-relaunch]`.
  - Writes `$DEPLOYED` as `<sha> <YYYY-mm-dd HH:MM:SS>`.
  - The refusal inside DSH prints `  <absolute path>/deploy.sh[ flags]`; the dry run inside DSH prints `the operator runs, from a terminal outside DSH: <command>`.

- [ ] **Step 1: Add the failing bench section** (needs `$SB/Sign.app` from Task 1's signing checks)

```bash
# ── deploy.sh ──
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
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy refuses while the live app has a turn running" '[[ $out == *"DEPLOY FAILED"*"turn(s) still running"* ]] && kill -0 '"$lpid"
kill "$lpid"; wait "$lpid" 2>/dev/null
rm -rf "$APPDIR/DeepSeek Harness.app"; mkdir -p "$APPDIR/DeepSeek Harness.app/Contents"; echo old > "$APPDIR/DeepSeek Harness.app/Contents/old"
out=$("$S/deploy.sh" --no-relaunch 2>&1)
check "deploy installs the artifact into the app path"  '[[ $out == *"DEPLOY OK: live"* ]] && [ -f "$APPDIR/DeepSeek Harness.app/Contents/MacOS/Sign" ] && [ ! -e "$APPDIR/DeepSeek Harness.app/Contents/old" ]'
check "deploy leaves no .new or .old bundle"            '[ ! -e "$APPDIR/DeepSeek Harness.app.new" ] && [ ! -e "$APPDIR/DeepSeek Harness.app.old" ]'
check "deploy stamps the deployed sha"                  '[ "$(cut -d" " -f1 "$LIVE/logs/rollout/deployed")" = "$FORKSHA" ]'
check "deploy runs the post-deploy hook"                '[ "$(cat "$LIVE/hook.out" 2>/dev/null)" = hook-ran ]'
```

- [ ] **Step 2: Run the bench, expect the deploy checks to fail**

Run: `bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | grep -E '^FAIL|failed|passed'`
Expected: `FAIL deploy …` lines.

- [ ] **Step 3: Write `scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
# Step 3/3. Install the verified artifact as the live Desktop: stop the test instance, quit the live
# app (its own quit confirmation guards running tasks), swap the bundle into $ROLLOUT_APP, stamp,
# run the post-deploy hook, reopen.
#
#   deploy.sh --dry-run     plan only (works inside DSH too)
#   deploy.sh               deploy (refuses unless verify.sh recorded the current branch sha)
#   deploy.sh --push        also push the branch first and, after the deploy, every feature-worktree
#                           branch (never forced) — ONLY on the operator's word
#   (refuses inside DSH, but --dry-run: it prints the command for the operator's own terminal)
#   --no-relaunch           leave the app closed
#   --unverified            install this sha's artifact although the verified stamp names another
#   --ignore-live-turns     deploy although a window it closes has a turn running
. "$(dirname "$0")/lib.sh"

dry_run=false push=false relaunch=true unverified=false ignore_live=false
for arg in "$@"; do
  case $arg in
    --dry-run) dry_run=true ;;
    --push) push=true ;;
    --no-relaunch) relaunch=false ;;
    --unverified) unverified=true ;;
    --ignore-live-turns) ignore_live=true ;;
    -h|--help) trap - EXIT; sed -n '2,15p' "$0"; exit 0 ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

step "preconditions"
cmd="$(cd "$(dirname "$0")" && pwd)/deploy.sh"
if $push; then cmd+=" --push"; fi
if ! $relaunch; then cmd+=" --no-relaunch"; fi
if $unverified; then cmd+=" --unverified"; fi
if $ignore_live; then cmd+=" --ignore-live-turns"; fi
if inside_dsh && ! $dry_run; then
  echo "Run from a terminal outside DSH (Terminal or Ghostty) once your DSH turns are done:"
  echo "  $cmd"
  fail "deploy is run by the operator, not from inside DSH (an agent session or its terminal)"
fi
require_config
require_branch_clean "$FORK"
new=$(git -C "$FORK" rev-parse "$BRANCH")
short=$(git -C "$FORK" rev-parse --short "$new")
ART=$ARTIFACTS/$new/$APP_NAME
warn_or_fail() { if $dry_run; then echo "WARNING: $1"; else fail "$1"; fi; }
if [ -f "$VERIFIED" ] && [ "$(cut -d' ' -f1 "$VERIFIED")" = "$new" ]; then
  echo "verified: $(cat "$VERIFIED")"
elif $unverified; then
  echo "WARNING: installing $short without a matching verified stamp (--unverified)"
else
  warn_or_fail "$BRANCH $short is not verified (run verify.sh; last: $(cat "$VERIFIED" 2>/dev/null || echo none))"
fi
if [ -d "$ART" ] && codesign --verify --deep --strict "$ART" 2>/dev/null; then
  echo "artifact: $ART"
else
  warn_or_fail "no valid artifact for $short at $ART (run verify.sh)"
fi
old=$(cut -d' ' -f1 "$DEPLOYED" 2>/dev/null || true)
echo "live $(git -C "$FORK" rev-parse --short "$old" 2>/dev/null || echo none) → $short"

# Turns die with the window that runs them: check the homes of the windows deploy closes.
live=""
if [ -n "$(bundle_pids "$APP")" ] || [ -n "$(bundle_pids "$LEGACY_APP")" ]; then live+=$(live_turns "$LIVE_HOME")$'\n'; fi
if [ -n "$(test_instance_pids)" ]; then live+=$(live_turns "$TEST_HOME"); fi
live=$(echo "$live" | sed '/^$/d')
if [ -n "$live" ]; then
  echo "running turns:"; echo "$live" | sed 's/^/  /'
  msg="$(echo "$live" | wc -l | tr -d ' ') turn(s) still running in a DSH window deploy would close"
  if $dry_run || $ignore_live; then echo "WARNING: $msg"; else fail "$msg (wait for them, or --ignore-live-turns)"; fi
fi

if $dry_run; then
  if $push; then echo "would run: git -C $FORK push $PUSH_REMOTE $BRANCH; after the deploy: git -C $FORK push $PUSH_REMOTE $(wt_branches | cut -f2 | xargs)"; fi
  quits=""
  if [ -n "$(test_instance_pids)" ]; then quits+=" the test instance,"; fi
  if [ -n "$(bundle_pids "$APP")" ]; then quits+=" $APP,"; fi
  if [ -n "$(bundle_pids "$LEGACY_APP")" ]; then quits+=" $LEGACY_APP,"; fi
  echo "would: quit${quits:- nothing,} install $ART into $APP, stamp $short$([ -n "$POST_DEPLOY" ] && echo ", run $POST_DEPLOY")$($relaunch && echo ", open $APP")"
  if inside_dsh; then echo "the operator runs, from a terminal outside DSH: $cmd"; fi
  ok "dry run"
  exit 0
fi

if $push; then
  step "push $BRANCH"
  git -C "$FORK" push "$PUSH_REMOTE" "$BRANCH" || fail "git push $PUSH_REMOTE $BRANCH failed (nothing deployed)"
fi

step "quit DSH Desktop"
stop_test_instance
quit_bundle "$APP"
quit_bundle "$LEGACY_APP"

step "install $APP"
install_bundle "$ART" "$APP"
echo "$new $(date '+%F %T')" >"$DEPLOYED"
echo "$APP is the build of $short"

if [ -n "$POST_DEPLOY" ]; then
  step "post-deploy hook"
  ROLLOUT_LIVE_HOME=$LIVE_HOME ROLLOUT_TEST_HOME=$TEST_HOME ROLLOUT_APP=$APP bash -c "$POST_DEPLOY" \
    || fail "post-deploy hook failed: $POST_DEPLOY ($APP is installed, the app stays closed)"
fi

if $relaunch; then
  step "open $APP"
  open "$APP"
fi

wt_note=""
if $push; then
  step "push worktree branches"
  wt=$(wt_branches | cut -f2 | xargs)
  if [ -n "$wt" ]; then
    # shellcheck disable=SC2086  # one refspec per branch
    if git -C "$FORK" push "$PUSH_REMOTE" $wt; then wt_note=", worktree branches pushed"
    else wt_note=", WARNING: some worktree branches not pushed (see above; never forced)"; fi
  fi
fi

ok "live $short$($push && echo ", $BRANCH pushed")$wt_note"
```

- [ ] **Step 4: Run the bench, expect all checks to pass**

Run: `chmod +x ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/deploy.sh && bash -n ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/deploy.sh && bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | tail -3`
Expected: `all passed`.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/dsh-tools && git add skills/dz-dsh-rollout && git commit -m "feat(dz-dsh-rollout): deploy.sh"
```

---

### Task 5: `state.sh`

**Files:**
- Create: `skills/dz-dsh-rollout/scripts/state.sh` (mode 755)
- Test: `skills/dz-dsh-rollout/tests/run.sh` (insert before `# ── summary ──`, after the deploy section: it relies on the installed sandbox app and stamps)

**Interfaces:**
- Consumes: `lib.sh`.
- Produces: `key=value` lines:
  - `harness`, `harness_detail`, `inside_dsh`;
  - `fork_branch`, `fork_sha`, `develop_present`, `develop_ahead_upstream`, `develop_behind_upstream`;
  - `worktree=<branch> +<n>` (repeated);
  - `verified`, `deployed`, `verified_is_head`;
  - `live`, `live_pid`, `app_present`, `test_instance`;
  - `open_turn=<line>` (repeated), `open_turns`;
  - `config`, `config_file`, `mode`.
  The last line is `STATE OK: mode=<mode>`.

- [ ] **Step 1: Add the failing bench section**

```bash
# ── state.sh ──
st() { "$S/state.sh" | grep "^$1=" | cut -d= -f2-; }
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
```

- [ ] **Step 2: Run the bench, expect the state checks to fail**

Run: `bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | grep -E '^FAIL|failed|passed'`
Expected: `FAIL state …` lines.

- [ ] **Step 3: Write `scripts/state.sh`**

```bash
#!/usr/bin/env bash
# Read-only: the harness running this, the fork and its integration branch, the verified and
# deployed stamps, the live and test apps, open turns, and the mode the skill is in. Prints
# key=value lines, then the result line.
#
#   mode   initial-setup (no config or no integration branch) | cutover (no live bundle yet, or the
#          legacy dev build still runs) | rollout
#
#   state.sh [--help]
. "$(dirname "$0")/lib.sh"
case ${1:-} in -h|--help) trap - EXIT; sed -n '2,9p' "$0"; exit 0 ;; esac

# The agent's own marker first: Claude Code or Codex started in a DSH terminal still inherit DSH_SHELL.
if [ -n "${DSH_SESSION_ID:-}" ]; then harness=dsh
elif [ "${CLAUDECODE:-}" = 1 ]; then harness=claude-code
elif env | grep -q '^CODEX_'; then harness=codex
elif [ "${DSH_SHELL:-}" = 1 ]; then harness=dsh
else harness=unknown; fi
detail=""; [ "$harness" = dsh ] && detail=${DSH_PROFILE:-}
inside=no; if inside_dsh; then inside=yes; fi

config=missing; [ -f "$ROLLOUT_CONFIG" ] && config=present
fork_branch="" fork_sha="" have_develop=no ahead="" behind=""
if [ -n "$FORK" ] && [ -e "$FORK/.git" ]; then
  fork_branch=$(git -C "$FORK" branch --show-current 2>/dev/null || true)
  fork_sha=$(git -C "$FORK" rev-parse --short HEAD 2>/dev/null || true)
  if git -C "$FORK" rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then have_develop=yes; fi
fi
head=""
if [ $have_develop = yes ]; then
  head=$(git -C "$FORK" rev-parse "$BRANCH")
  if counts=$(git -C "$FORK" rev-list --left-right --count "$BRANCH...$UPSTREAM" 2>/dev/null); then
    ahead=${counts%%[[:space:]]*}; behind=${counts##*[[:space:]]}
  fi
fi
verified=$(cat "$VERIFIED" 2>/dev/null || true)
deployed=$(cat "$DEPLOYED" 2>/dev/null || true)
verified_is_head=no
[ -n "$head" ] && [ "${verified%% *}" = "$head" ] && verified_is_head=yes

live=none live_pid=""
if [ -n "$(bundle_pids "$APP")" ]; then live=app; live_pid=$(bundle_pids "$APP" | head -1)
elif [ -n "$(bundle_pids "$LEGACY_APP")" ]; then live=legacy; live_pid=$(bundle_pids "$LEGACY_APP" | head -1); fi
app_present=no; [ -d "$APP" ] && app_present=yes
test_instance=none; [ -n "$(test_instance_pids)" ] && test_instance="running $(test_instance_sha)"
turns=$( { live_turns "$LIVE_HOME"; live_turns "$TEST_HOME"; } | sed '/^$/d')

if [ $have_develop = no ]; then mode=initial-setup   # also covers no fork configured
elif [ $app_present = no ] || [ $live = legacy ]; then mode=cutover
else mode=rollout; fi

echo "harness=$harness"
echo "harness_detail=$detail"
echo "inside_dsh=$inside"
echo "fork_branch=$fork_branch"
echo "fork_sha=$fork_sha"
echo "develop_present=$have_develop"
echo "develop_ahead_upstream=$ahead"
echo "develop_behind_upstream=$behind"
if [ $have_develop = yes ]; then
  while IFS=$'\t' read -r _ branch; do
    [ -n "$branch" ] || continue
    echo "worktree=$branch +$(git -C "$FORK" rev-list --count "$BRANCH..$branch")"
  done < <(wt_branches)
fi
echo "verified=$verified"
echo "deployed=$deployed"
echo "verified_is_head=$verified_is_head"
echo "live=$live"
echo "live_pid=$live_pid"
echo "app_present=$app_present"
echo "test_instance=$test_instance"
if [ -n "$turns" ]; then echo "$turns" | sed 's/^/open_turn=/'; fi
echo "open_turns=$(echo "$turns" | sed '/^$/d' | wc -l | tr -d ' ')"
echo "config=$config"
echo "config_file=$ROLLOUT_CONFIG"
echo "mode=$mode"
ok "mode=$mode"
```

- [ ] **Step 4: Run the bench, expect all checks to pass**

Run: `chmod +x ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/state.sh && bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | tail -3`
Expected: `all passed`.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/dsh-tools && git add skills/dz-dsh-rollout && git commit -m "feat(dz-dsh-rollout): state.sh"
```

---

### Task 6: `plugins/` — provider-limits copy and the relink hook

**Files:**
- Create: `plugins/provider-limits/` (copy of `~/dev/dsh-plugins/provider-limits`, without `node_modules`/`.DS_Store`)
- Create: `plugins/install.sh` (mode 755)
- Test: `plugins/tests/run.sh` (mode 755)

**Interfaces:**
- Consumes: env `ROLLOUT_LIVE_HOME`, `ROLLOUT_TEST_HOME`, `ROLLOUT_APP` (set by deploy.sh); overrides `ROLLOUT_NODE`, `ROLLOUT_PNPM`, `DSH_TOOLS_OLD_PLUGINS`.
- Produces: for each home's `profiles/desktop/package.json`, `link:<old root>/<name>` becomes `link:<dsh-tools>/plugins/<name>`, followed by `pnpm install`. Prints `<profile>: <n> link plugin(s) now under <dir>` or `<profile>: no link plugin under <old root>`.

- [ ] **Step 1: Copy the plugin** (`~/dev/dsh-plugins` stays untouched until Task 8)

```bash
mkdir -p ~/dev/dsh-tools/plugins
rsync -a --exclude node_modules --exclude .DS_Store ~/dev/dsh-plugins/provider-limits/ ~/dev/dsh-tools/plugins/provider-limits/
diff -r -x node_modules -x .DS_Store ~/dev/dsh-plugins/provider-limits ~/dev/dsh-tools/plugins/provider-limits && echo identical
(cd ~/dev/dsh-tools/plugins/provider-limits && node --test tests/)
```
Expected: `identical`; the plugin's own tests pass.

- [ ] **Step 2: Write the failing bench `plugins/tests/run.sh`**

```bash
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
[ -f "$ROLLOUT_PNPM" ] || { echo "skip: no pnpm entry at $ROLLOUT_PNPM"; exit 0; }

OLD="$SB/old-plugins"; mkdir -p "$OLD/provider-limits"
cp "$P/provider-limits/package.json" "$OLD/provider-limits/package.json"
H="$SB/home"; PR="$H/profiles/desktop"; mkdir -p "$PR"
cat > "$PR/package.json" <<EOF
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/dsh-provider-limits": "link:$OLD/provider-limits"
  }
}
EOF
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

echo
if [ $FAILS -eq 0 ]; then echo "all passed"; else echo "$FAILS failed"; fi
exit $FAILS
```

- [ ] **Step 3: Run it, expect failures**

Run: `bash ~/dev/dsh-tools/plugins/tests/run.sh`
Expected: `FAIL` lines (install.sh missing).

- [ ] **Step 4: Write `plugins/install.sh`**

```bash
#!/usr/bin/env bash
# Point the DSH Desktop profiles' link plugins at this directory and reinstall the profiles with the
# app's bundled pnpm. dz-dsh-rollout runs it after each deploy, while every DSH window is closed
# (Desktop never runs pnpm at startup). Idempotent.
#
# Environment: ROLLOUT_LIVE_HOME, ROLLOUT_TEST_HOME (homes whose profiles/desktop is fixed),
# ROLLOUT_APP (bundled Node and pnpm; ROLLOUT_NODE / ROLLOUT_PNPM override them),
# DSH_TOOLS_OLD_PLUGINS (the retired plugin root, default ~/dev/dsh-plugins).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OLD=${DSH_TOOLS_OLD_PLUGINS:-$HOME/dev/dsh-plugins}
APP=${ROLLOUT_APP:-$HOME/Applications/DeepSeek Harness.app}
RT="$APP/Contents/Resources/runtime/primary-runtime/dependencies"
NODE=${ROLLOUT_NODE:-$RT/node/bin/node}
PNPM=${ROLLOUT_PNPM:-$RT/pnpm/bin/pnpm.mjs}
[ -x "$NODE" ] || { echo "plugins/install.sh: no Node at $NODE" >&2; exit 1; }
[ -f "$PNPM" ] || { echo "plugins/install.sh: no pnpm at $PNPM" >&2; exit 1; }

for home in "${ROLLOUT_LIVE_HOME:-$HOME/.dsh}" "${ROLLOUT_TEST_HOME:-$HOME/.dsh-dev}"; do
  profile=$home/profiles/desktop
  [ -f "$profile/package.json" ] || continue
  changed=$("$NODE" -e '
    const fs = require("fs")
    const [file, oldRoot, newRoot] = process.argv.slice(1)
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    let n = 0
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
      for (const [name, spec] of Object.entries(deps || {})) {
        if (typeof spec === "string" && spec.startsWith(`link:${oldRoot}/`)) {
          deps[name] = `link:${newRoot}/${spec.slice(`link:${oldRoot}/`.length)}`
          n++
        }
      }
    }
    if (n > 0) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
    console.log(n)' "$profile/package.json" "$OLD" "$HERE")
  if [ "$changed" = 0 ]; then echo "$profile: no link plugin under $OLD"; continue; fi
  "$NODE" "$PNPM" --dir "$profile" install --no-frozen-lockfile \
    || { echo "plugins/install.sh: pnpm install failed in $profile" >&2; exit 1; }
  echo "$profile: $changed link plugin(s) now under $HERE"
done
```

- [ ] **Step 5: Run the bench, expect all checks to pass**

Run: `chmod +x ~/dev/dsh-tools/plugins/install.sh ~/dev/dsh-tools/plugins/tests/run.sh && bash ~/dev/dsh-tools/plugins/tests/run.sh`
Expected: `all passed`. If pnpm needs network or refuses the lockfile, stop and report the exact error: the hook's invocation changes here, not in deploy.sh.

- [ ] **Step 6: Prove it on a copy of the real live profile** (read-only for `~/.dsh`)

```bash
T=$(mktemp -d); mkdir -p "$T/home/profiles"
cp -a ~/.dsh/profiles/desktop "$T/home/profiles/desktop"
ROLLOUT_NODE=$(command -v node) ROLLOUT_PNPM=~/dev/deepseek-harness/apps/desktop/node_modules/pnpm/bin/pnpm.mjs \
  ROLLOUT_LIVE_HOME="$T/home" ROLLOUT_TEST_HOME="$T/none" bash ~/dev/dsh-tools/plugins/install.sh
grep dsh-provider-limits "$T/home/profiles/desktop/package.json"
(cd "$T/home/profiles/desktop/node_modules/@local/dsh-provider-limits" && pwd -P)
rm -rf "${T:?}"
```
Expected: `1 link plugin(s) now under /Users/frenzy/dev/dsh-tools/plugins`; `package.json` shows `link:/Users/frenzy/dev/dsh-tools/plugins/provider-limits`; `pwd -P` prints `/Users/frenzy/dev/dsh-tools/plugins/provider-limits`.

- [ ] **Step 7: Commit**

```bash
cd ~/dev/dsh-tools && git add plugins && git commit -m "feat(plugins): provider-limits from dsh-plugins, relink hook for Desktop profiles"
```

---

### Task 7: `SKILL.md`, `references/setup.md`, `skills/install.sh`

**Files:**
- Create: `skills/dz-dsh-rollout/SKILL.md`, `skills/dz-dsh-rollout/references/setup.md`
- Create: `skills/install.sh` (mode 755)
- Test: `skills/dz-dsh-rollout/tests/run.sh` (insert before `# ── summary ──`)

**Interfaces:**
- Consumes: the CLIs and outputs from Tasks 2–6.
- Produces: CLI `skills/install.sh [--target agents|claude|codex] [--force] [<skill>...]`, printing `installed <name> → <dir>` or `skip <name>: <dir> exists (--force replaces it)`.

- [ ] **Step 1: Add the failing bench section**

```bash
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
```

- [ ] **Step 2: Run the bench, expect the install checks to fail**

Run: `bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | grep -E '^FAIL|failed|passed'`
Expected: `FAIL install.sh …` lines.

- [ ] **Step 3: Write `skills/install.sh`**

```bash
#!/usr/bin/env bash
# Install dsh-tools skills.
#
#   ./install.sh [--target agents|claude|codex] [--force] [<skill>...]
#
# --target agents (default) installs into ~/.agents/skills/ (every DSH home reads it), claude into
# ~/.claude/skills/, codex into ${CODEX_HOME:-~/.codex}/skills/. Without names: every skill here.
# An installed copy is replaced only with --force; the old copy moves to <root>/backups/skills/.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=agents FORCE=false NAMES=()
while [ $# -gt 0 ]; do
  case $1 in
    --target) TARGET=${2:?--target needs a value}; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done
case $TARGET in
  agents) ROOT=$HOME/.agents ;;
  claude) ROOT=$HOME/.claude ;;
  codex) ROOT=${CODEX_HOME:-$HOME/.codex} ;;
  *) echo "install.sh: --target must be agents, claude or codex" >&2; exit 2 ;;
esac
if [ ${#NAMES[@]} -eq 0 ]; then
  for d in "$HERE"/*/; do if [ -f "$d/SKILL.md" ]; then NAMES+=("$(basename "$d")"); fi; done
fi
[ ${#NAMES[@]} -gt 0 ] || { echo "install.sh: no skills in $HERE" >&2; exit 1; }
mkdir -p "$ROOT/skills"
for name in "${NAMES[@]}"; do
  src=$HERE/$name dst=$ROOT/skills/$name
  [ -f "$src/SKILL.md" ] || { echo "install.sh: no skill $name in $HERE" >&2; exit 1; }
  if [ -e "$dst" ]; then
    if ! $FORCE; then echo "skip $name: $dst exists (--force replaces it)"; continue; fi
    mkdir -p "$ROOT/backups/skills"
    mv "$dst" "$ROOT/backups/skills/$name-$(date +%Y%m%d-%H%M%S)"
  fi
  cp -R "$src" "$dst"
  echo "installed $name → $dst"
done
```

- [ ] **Step 4: Write `skills/dz-dsh-rollout/SKILL.md`**

````markdown
---
name: dz-dsh-rollout
description: "Use when rolling the operator's DeepSeek Harness (DSH) fork out to their live DSH Desktop: setting up the integration branch, merging feature worktrees or upstream into develop, verifying it on the isolated test instance (~/.dsh-dev), deploying the verified build into ~/Applications, or checking where the rollout stands."
version: 1.0.0
author: Denis Zamataev
license: MIT
platforms: [macos]
---

# Roll out a DSH fork to the live Desktop

For an operator who works in DSH Desktop built from their own fork. Features live in worktrees of
the fork; the integration branch collects them (and upstream); live runs a build of that branch.
Every change reaches live through three gated steps.

```
feature worktrees ─┐                       1. merge.sh [--upstream]      (git only, in the fork)
upstream branch ───┴─merge──▶ fork <integration branch>
                                  │ 2. verify.sh: build worktree at the sha → tests vs upstream →
                                  │    signed .app artifact → test instance (~/.dsh-dev) → operator checks it
                                  │ 3. deploy.sh [--push]: the same artifact
                                  ▼
                 ~/Applications/DeepSeek Harness.app   (live, home ~/.dsh)
```

Scripts: `scripts/` next to this file. Each ends with one result line `MERGE|VERIFY|DEPLOY|STATE
OK: …` or `… FAILED: …` and posts a macOS notification. `--help` on any script lists its flags.
Configuration: `~/.config/dz-dsh-rollout/config.sh` (template `templates/config.sh`).

`dz-dsh-rollout help`: explain to the operator, in their language, the modes `state.sh` finds, the
three steps and their gates, and the scripts' flags; run nothing else.

## Start: where am I

Run `scripts/state.sh` first. Branch on `mode`:

- `initial-setup` or `cutover`: follow [references/setup.md](references/setup.md).
- `rollout`: the Procedure below.

`inside_dsh=yes` means this agent runs inside DSH (an agent session or a DSH terminal). It may run
`state.sh`, `merge.sh`, `verify.sh` and `deploy.sh --dry-run` itself: verify starts the test
instance next to live without touching it. `deploy.sh` itself quits DSH, which would kill this
agent: give the operator the absolute command `deploy.sh --dry-run` prints, to run from Terminal or
Ghostty once their DSH turns are done.

## Procedure

1. **Merge.** `merge.sh --dry-run` (with `--upstream` when the operator wants upstream). Show the
   branch list. For each `to merge: <branch> (+N; M over <upstream>)`, N far above M means the
   branch was cut from a newer upstream than develop's last sync: merging it IS an upstream merge.
   Say so with both numbers and run `merge.sh --upstream`. Every branch ahead is merged, a
   half-finished one included: when one is not meant to ship, stop and ask. Then `merge.sh`. A
   conflict aborts that merge and stops: resolve it by hand in the fork so both sides survive,
   commit the merge with the resolutions listed, rerun.
2. **Verify.** `verify.sh`. The first install and packaging take long; report the step and log
   when silent for minutes. On `FAILED`, read the log the line names.
   - Test failures that upstream lacks are ours: fix them in the owning worktree, merge, verify
     again. A verify failure is the agent's to resolve, whoever's merge brought it.
   - `--no-tests` (stamp `tests=none`) when the tests already passed for this exact sha and only a
     later stage failed. `--full` on the operator's word.
   - On success hand the operator a checklist for the test window: a normal chat on each provider
     they use (TeamClaude must answer, not 429), and each merged feature, concretely. Wait for
     their confirmation.
   - A branch changed after verify: `merge.sh && verify.sh` rebuilds and restarts the test instance.
   - Errors the operator reports from the test window: `~/.dsh-dev/instance.log`, and the session
     logs under `~/.dsh-dev/sessions/`.
   - A verify the operator started in their own terminal: read `~/.dsh/logs/rollout/` (`verified`,
     `verify-*.log`) and `ps -axo etime,command | grep '[v]erify.sh'`. No verify process and
     `verified` on the old sha means it failed: the newest log names the stage.
   - Run `deploy.sh --dry-run` right after verify: it shows what deploy would close and refuse.
3. **Deploy, only after the operator confirms.** `deploy.sh` (`--push` only on the operator's
   explicit word).
   - Re-check `git -C <fork> log -1 --oneline develop` first: another session may have merged
     since verify, and deploy then refuses the unverified sha.
   - From inside DSH, hand over the command (see Start).
   - It refuses while a turn runs in a window it closes. The app also asks itself on quit; a
     Cancel there fails the deploy with nothing installed.
   - Afterwards check: `state.sh` (`deployed` = develop, `live=app`); `codesign -d -r-` of the app
     names the team; the operator's chat works. Report the deployed sha.

## Rules

- **Push only on the operator's explicit word**, to the fork's remote. `--push` pushes develop
  before the deploy and every worktree branch after it; a rejected branch is reported, never
  forced.
- **Deploy is the operator's** whenever this agent runs inside DSH.
- **Live turns block deploy**; `--ignore-live-turns` and `--unverified` only on the operator's word.
- **Processes by executable path**, never `pgrep -f`: macOS can withhold argv.
- **Worktrees only on the operator's permission**, at `~/dev/<project>-wt/<name>`. The build
  worktree (`ROLLOUT_BUILD_WT`) is verify's: never commit in it.

## What deploy does

Preconditions (fork clean on develop, develop = verified sha, artifact signature valid, no live
turns) → `--push` develop → stop the test instance → quit the live app and the legacy dev build by
ordinary quit → swap the artifact into `ROLLOUT_APP` (`.new`/`.old`, restored on failure) → stamp
`deployed` → post-deploy hook (`plugins/install.sh`: profile link plugins, bundled pnpm) → open the
app → `--push` worktree branches.

## Pitfalls

- **Nothing builds in the fork checkout.** Before cutover, live runs the checkout's `lib/`; a
  `pnpm run build*` there changes code under it. Builds happen only in the build worktree.
- **In-app updates do not apply**: the unsigned package carries no update feed. Update only through
  these scripts.
- **TCC**: the first launch of a newly signed app asks for accessibility and screen recording once.
  The grants survive rebuilds while `ROLLOUT_SIGN_IDENTITY` stays; changing it resets them.
- **Two bundles share `com.deepseek.harness`** (live and the test artifact). Always address apps by
  path; `open -b` may pick either. The test instance claims `dsh://` while it runs; reopening live
  reclaims it.
- **"ignored --user-data-dir"** from verify means the packaged Electron did not honor the switch;
  the test instance would hand off to live's single-instance lock. Stop and report: do not start
  the test instance with live's userData.
- **The test home has no `.credentials.yaml`**: a DeepSeek account sign-in, if used, happens again
  there. API keys come from the seeded `.env`. `verify.sh --reseed` refreshes the seed from live.
- **Desktop never runs pnpm at startup**: a plugin change in a profile needs the app closed and
  `plugins/install.sh` (deploy runs it).
- **Fixing these scripts**: edit `~/dev/dsh-tools/skills/dz-dsh-rollout/`, run `bash -n` and
  `tests/run.sh`, reinstall with `skills/install.sh --target agents --force dz-dsh-rollout`, commit
  in dsh-tools; push only on the operator's word.
````

- [ ] **Step 5: Write `skills/dz-dsh-rollout/references/setup.md`**

````markdown
# Setup and cutover

Run `state.sh` first and tell the operator in one line what it found. Every step that changes
their machine waits for their explicit yes; ask one at a time.

## Modes

| `mode` | Means | Do |
|---|---|---|
| `initial-setup` | no config, or no integration branch | [Configuration](#configuration), then [Integration branch](#integration-branch) |
| `cutover` | `ROLLOUT_APP` absent, or the legacy dev build still runs | [Cutover](#cutover) |
| `rollout` | everything in place | the skill's Procedure |

## Configuration

1. `skills/install.sh --target agents` in `~/dev/dsh-tools` (DSH reads `~/.agents/skills`).
2. Copy `templates/config.sh` to `~/.config/dz-dsh-rollout/config.sh` and fill it in:
   - fork checkout, integration branch, worktree root, build worktree path (the operator approves
     the path);
   - upstream `<remote>/<branch>` (`git -C <fork> remote -v`);
   - the sign identity (`security find-identity -v -p codesigning`; prefer `Developer ID
     Application`);
   - `ROLLOUT_LEGACY_APP` = the dev build live runs now, when it is not yet in `ROLLOUT_APP`
     (`ps -axo pid,comm | grep -i harness`).

## Integration branch

1. `git -C <fork> branch develop <upstream remote>/<branch>` and `git -C <fork> switch develop`.
   The checkout must be clean. Switching branches does not touch a running dev build: it executes
   the built `lib/`, which the switch leaves alone.
2. A feature branch without a worktree (checked out in the fork until now): merge it once by hand,
   `git -C <fork> merge --no-ff <branch>`.
3. `merge.sh --dry-run`, then `merge.sh`.

## Cutover

The first deploy moves live from the dev build to `ROLLOUT_APP`.

1. `verify.sh`, then the operator checks the test window. The first run also proves the re-signed
   bundle launches and honors `--user-data-dir`.
2. The operator runs `deploy.sh` from Terminal or Ghostty (the command `deploy.sh --dry-run`
   prints). It quits the dev build (ordinary quit, so it confirms running tasks), installs the app,
   runs `plugins/install.sh`, opens the app.
3. The operator grants TCC permissions to the new app once (System Settings → Privacy & Security).
4. Check:
   - sessions from `~/.dsh` are listed;
   - the provider-limits chip shows;
   - `codesign -d -r- "$ROLLOUT_APP"` names the team;
   - `state.sh` shows `mode=rollout`.
   Then empty `ROLLOUT_LEGACY_APP` in the config.
5. Fallback when the new app fails: `DSH_HOME=~/.dsh pnpm run start:desktop` in the fork checkout
   reuses the old build.
6. On the operator's word: archive the retired `dsh-plugins` repository on GitHub and remove
   `~/dev/dsh-plugins` (its `provider-limits` is a symlink into `dsh-tools/plugins` since setup).
````

- [ ] **Step 6: Run the bench, expect all checks to pass**

Run: `chmod +x ~/dev/dsh-tools/skills/install.sh && bash ~/dev/dsh-tools/skills/dz-dsh-rollout/tests/run.sh | tail -3 && for f in ~/dev/dsh-tools/skills/dz-dsh-rollout/scripts/*.sh ~/dev/dsh-tools/skills/install.sh ~/dev/dsh-tools/plugins/install.sh; do bash -n "$f" || echo "syntax: $f"; done`
Expected: `all passed`, no `syntax:` lines.

- [ ] **Step 7: Install the skill and commit**

```bash
~/dev/dsh-tools/skills/install.sh --target agents dz-dsh-rollout
cd ~/dev/dsh-tools && git add skills && git commit -m "feat(dz-dsh-rollout): SKILL.md, setup reference, skills/install.sh"
```
Expected: `installed dz-dsh-rollout → /Users/frenzy/.agents/skills/dz-dsh-rollout`.

---

### Task 8: Machine setup — config, plugin symlink, `develop`

Each step marked **[operator yes]** waits for the operator's explicit yes in chat.

- [ ] **Step 1: [operator yes] Write `~/.config/dz-dsh-rollout/config.sh`**

```bash
mkdir -p ~/.config/dz-dsh-rollout
cat > ~/.config/dz-dsh-rollout/config.sh <<'EOF'
# dz-dsh-rollout configuration (template: dsh-tools/skills/dz-dsh-rollout/templates/config.sh).
# shellcheck shell=bash disable=SC2034
ROLLOUT_FORK=$HOME/dev/deepseek-harness
ROLLOUT_BRANCH=develop
ROLLOUT_WT_ROOT=$HOME/dev/deepseek-harness-wt
ROLLOUT_BUILD_WT=$HOME/dev/deepseek-harness-wt/rollout-build
ROLLOUT_UPSTREAM=deepseek-ai/master
ROLLOUT_PUSH_REMOTE=origin
ROLLOUT_LIVE_HOME=$HOME/.dsh
ROLLOUT_TEST_HOME=$HOME/.dsh-dev
ROLLOUT_APP="$HOME/Applications/DeepSeek Harness.app"
ROLLOUT_SIGN_IDENTITY="Developer ID Application: Denis Zamataev (68QJJA7HK9)"
ROLLOUT_LEGACY_APP="$HOME/dev/deepseek-harness/apps/desktop/.desktop-build/development/Harness Dev.app"
ROLLOUT_POST_DEPLOY="$HOME/dev/dsh-tools/plugins/install.sh"
EOF
~/.agents/skills/dz-dsh-rollout/scripts/state.sh
```
Expected: `mode=initial-setup` (no `develop` yet), `live=legacy`, `config=present`.

- [ ] **Step 2: [operator yes] Replace `~/dev/dsh-plugins/provider-limits` with a symlink to dsh-tools**

```bash
diff -r -x node_modules -x .DS_Store ~/dev/dsh-plugins/provider-limits ~/dev/dsh-tools/plugins/provider-limits && \
  mv ~/dev/dsh-plugins/provider-limits ~/dev/dsh-plugins/provider-limits.retired && \
  ln -s ~/dev/dsh-tools/plugins/provider-limits ~/dev/dsh-plugins/provider-limits && \
  (cd ~/.dsh/profiles/desktop/node_modules/@local/dsh-provider-limits && pwd -P)
```
Expected: `/Users/frenzy/dev/dsh-tools/plugins/provider-limits`. The running live keeps its loaded modules; its next start follows the link. `provider-limits.retired` is removed with the rest of `~/dev/dsh-plugins` at the end of cutover.

- [ ] **Step 3: [operator yes] Create `develop` and merge `feat/claude-code-relay`**

```bash
cd ~/dev/deepseek-harness
git status --porcelain --untracked-files=no | wc -l    # must print 0
git fetch -q deepseek-ai
git branch develop deepseek-ai/master
git switch develop
git merge --no-ff --no-edit -m "merge: feat/claude-code-relay into develop" feat/claude-code-relay
git log --oneline -3
```
Expected: `develop` = merge commit over `687f282e86` (or a newer `deepseek-ai/master`) carrying `19f5f99fd2`.

- [ ] **Step 4: Merge the feature worktrees**

Run: `~/.agents/skills/dz-dsh-rollout/scripts/merge.sh --dry-run`
Expected: `to merge: feat/composer-prediction (+23; 23 over deepseek-ai/master)` (when upstream moved, N and M differ: report it and ask about `--upstream`), `MERGE OK: dry run …`.

**[operator yes]** Run: `~/.agents/skills/dz-dsh-rollout/scripts/merge.sh`
Expected: `MERGE OK: develop at <sha>, merged 1 branch(es): feat/composer-prediction; next: verify.sh`. On conflict: resolve in `~/dev/deepseek-harness` per SKILL.md, commit, rerun.

- [ ] **Step 5: State check**

Run: `~/.agents/skills/dz-dsh-rollout/scripts/state.sh`
Expected: `develop_present=yes`, `mode=cutover`.

---

### Task 9: First verify (proves packaging, signing, `--user-data-dir`)

- [ ] **Step 1: Run verify** (creates the approved build worktree; long: run as a background job and report each `==` stage)

Run: `~/.agents/skills/dz-dsh-rollout/scripts/verify.sh`
Expected: `VERIFY OK: develop <sha> verified (tests=changed, app=true) …`.

On failure, by stage:
- `pnpm install` / `build:native-system`: read `verify-install.log`; network or toolchain issues go to the operator.
- vitest `ours`: fix in the owning worktree (`feat/composer-prediction` or a new fix branch, worktree only with the operator's yes), merge, verify again.
- packaging: read `verify-package.log`; `apps/desktop/packaging/README.md` § Local macOS DMG documents the command.
- signing / `requirement_ok`: spike result. Report `verify-sign.log` and `codesign -d -r-` output and stop for the operator: the alternative is the repo's signed packaging path.
- `test instance exited` / `not listening` / `ignored --user-data-dir`: report `~/.dsh-dev/instance.log` and stop. Do not work around by sharing live's userData.

- [ ] **Step 2: Verify isolation from live**

```bash
~/.agents/skills/dz-dsh-rollout/scripts/state.sh | grep -E '^(live|test_instance|verified_is_head)='
ls ~/.dsh-dev ~/.dsh-dev/electron-user-data | head -30
test ! -e ~/.dsh-dev/.credentials.yaml && echo "no credentials copied"
codesign -d -r- ~/.dsh-dev/artifacts/*/"DeepSeek Harness.app" 2>&1 | grep designated
```
Expected: `live=legacy`, `test_instance=running <sha>`, `verified_is_head=yes`; SingletonLock in the test userData; `no credentials copied`; the requirement names `com.deepseek.harness` and `68QJJA7HK9`.

- [ ] **Step 3: Hand the operator the test checklist and wait**

In the test window (`~/.dsh-dev`):
1. A normal chat on a TeamClaude model: an answer, no 429 (proves `claudeCodeVersion`).
2. A chat on codex-lb and OpenCode Go.
3. Composer prediction behaves as built in `feat/composer-prediction`.
4. The provider-limits chip shows quotas.
5. Live (`Harness Dev.app`) still works and lists its sessions.

- [ ] **Step 4: Dry-run the deploy**

Run: `~/.agents/skills/dz-dsh-rollout/scripts/deploy.sh --dry-run`
Expected: `verified: …`, `artifact: …`, the plan (quit the test instance and `Harness Dev.app`, install into `~/Applications/DeepSeek Harness.app`, run the hook, open), `running turns:` listing this agent's own session, and `the operator runs, from a terminal outside DSH: /Users/frenzy/.agents/skills/dz-dsh-rollout/scripts/deploy.sh`.

---

### Task 10: Cutover (operator runs the deploy)

- [ ] **Step 1: Give the operator the command and the order**

1. Let running DSH turns finish (this session included).
2. In Terminal or Ghostty: `/Users/frenzy/.agents/skills/dz-dsh-rollout/scripts/deploy.sh`.
3. When DSH asks to confirm quitting, confirm only if no task matters.
4. Grant accessibility / screen recording to `DeepSeek Harness` when macOS asks (or in System Settings → Privacy & Security).

- [ ] **Step 2: After the operator reports back, check**

```bash
~/.agents/skills/dz-dsh-rollout/scripts/state.sh | grep -E '^(live|deployed|verified_is_head|mode)='
codesign -d -r- ~/Applications/"DeepSeek Harness.app" 2>&1 | grep designated
grep dsh-provider-limits ~/.dsh/profiles/desktop/package.json
tail -5 ~/.dsh/logs/rollout/deployed
```
Expected: `live=app`, `deployed=<develop sha> …`, `mode=cutover` until `ROLLOUT_LEGACY_APP` is emptied; the requirement names the team; the profile links `link:/Users/frenzy/dev/dsh-tools/plugins/provider-limits`.

- [ ] **Step 3: [operator yes] Clear the legacy app**

```bash
sed -i '' 's|^ROLLOUT_LEGACY_APP=.*|ROLLOUT_LEGACY_APP=|' ~/.config/dz-dsh-rollout/config.sh
~/.agents/skills/dz-dsh-rollout/scripts/state.sh | grep '^mode='
```
Expected: `mode=rollout`.

- [ ] **Step 4: [operator yes] Retire dsh-plugins**

```bash
grep -rl 'dev/dsh-plugins' ~/.dsh/profiles/*/package.json ~/.dsh-dev/profiles/*/package.json 2>/dev/null   # must print nothing
rm -rf ~/dev/dsh-plugins
gh repo archive DZamataev/dsh-plugins --yes
```
Expected: no profile references `dev/dsh-plugins`; the repository is archived.

- [ ] **Step 5: Report**

The deployed sha, the `develop` sha, what was merged, and what stays unpushed (`develop` and `feat/composer-prediction` until the operator says `--push`; `dsh-tools` has no remote until the operator creates one).
