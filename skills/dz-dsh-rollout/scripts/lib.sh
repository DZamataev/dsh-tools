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

# A directory's physical path; a missing one keeps its configured string (minus a trailing slash).
canon_path() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s\n' "${1%/}"; fi
}
# The physical git common dir of a checkout or worktree ($1), empty when it is not one.
git_common_dir() {
  local d
  d=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 0
  case $d in /*) ;; *) d=$1/$d ;; esac
  canon_path "$d"
}
# Misplaced paths make verify or deploy act on the wrong tree or home.
require_distinct_paths() {
  local live test fork build
  live=$(canon_path "$LIVE_HOME"); test=$(canon_path "$TEST_HOME")
  if [ "$live" = "$test" ] || [[ "$live/" == "$test/"* ]] || [[ "$test/" == "$live/"* ]]; then
    fail "ROLLOUT_TEST_HOME and ROLLOUT_LIVE_HOME overlap: $test and $live"
  fi
  [ -n "$BUILD_WT" ] || return 0
  fork=$(canon_path "$FORK"); build=$(canon_path "$BUILD_WT")
  if [ "$build" = "$fork" ] || [[ "$build/" == "$fork/"* ]]; then
    fail "ROLLOUT_BUILD_WT must be a separate worktree, not the fork checkout: $build"
  fi
  if [ -e "$BUILD_WT/.git" ] && [ "$(git_common_dir "$BUILD_WT")" != "$(git_common_dir "$FORK")" ]; then
    fail "ROLLOUT_BUILD_WT is not a worktree of ROLLOUT_FORK: $build"
  fi
}
require_config() {
  [ -n "$FORK" ] || fail "ROLLOUT_FORK is not set — copy templates/config.sh to $ROLLOUT_CONFIG and fill it in"
  [ -e "$FORK/.git" ] || fail "ROLLOUT_FORK is not a git checkout: $FORK"
  require_distinct_paths
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
# "<pid> <bundle>" for every process whose executable sits directly in <bundle>.app/Contents/MacOS/
# and whose bundle's CFBundleIdentifier starts with $BUNDLE_ID (any DSH Desktop, the test instance and
# dev builds included). Nested helper apps (Contents/Frameworks/…) are not listed.
desktop_pids() {
  local cands bundles b id good=""
  cands=$(proc_paths | awk '{
    pid = $1; exe = substr($0, length($1) + 2)
    i = index(exe, "/Contents/MacOS/"); if (i == 0) next
    bundle = substr(exe, 1, i - 1); rest = substr(exe, i + 16)
    if (rest == "" || index(rest, "/") > 0) next
    if (bundle !~ /\.app$/ || index(bundle, "/Contents/") > 0) next
    print pid " " bundle }')
  [ -n "$cands" ] || return 0
  bundles=$(printf '%s\n' "$cands" | cut -d' ' -f2- | sort -u)
  while IFS= read -r b; do
    id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$b/Contents/Info.plist" 2>/dev/null || true)
    if [[ "$id" == "$BUNDLE_ID"* ]]; then good+="$b"$'\n'; fi
  done <<< "$bundles"
  [ -n "$good" ] || return 0
  while IFS= read -r b; do
    if printf '%s' "$good" | grep -qxF -- "${b#* }"; then printf '%s\n' "$b"; fi
  done <<< "$cands"
}
# Bundles of the DSH Desktops that are neither $APP, $LEGACY_APP nor a test artifact, one per line.
other_desktop_bundles() {
  local b
  desktop_pids | cut -d' ' -f2- | sort -u | while IFS= read -r b; do
    if [ "$b" = "$APP" ]; then continue; fi
    if [ -n "$LEGACY_APP" ] && [ "$b" = "$LEGACY_APP" ]; then continue; fi
    case $b in "$ARTIFACTS"/*) continue ;; esac
    printf '%s\n' "$b"
  done
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
  local err rc=0
  [ -n "${1:-}" ] || return 0
  [ -n "$(bundle_pids "$1")" ] || return 0
  err=$(osascript -e "tell application \"$1\" to quit" 2>&1 >/dev/null) || rc=$?
  if [ $rc -ne 0 ]; then
    if [[ "$err" == *-1743* ]]; then
      fail "macOS refused the Apple event to quit $1 — allow your terminal to control it in System Settings → Privacy & Security → Automation, then deploy again; nothing installed"
    fi
    fail "osascript could not quit $1: $(printf '%s\n' "$err" | head -1) — nothing installed"
  fi
  for _ in $(seq 1 "${ROLLOUT_QUIT_TIMEOUT:-120}"); do [ -n "$(bundle_pids "$1")" ] || return 0; sleep 1; done
  fail "$1 is still running after ${ROLLOUT_QUIT_TIMEOUT:-120} s — answer or dismiss its quit dialog (Quit only if nothing runs), then deploy again; nothing installed"
}

# ── turns ─────────────────────────────────────────────────────────────────────────────────────
# Open agent turns in a DSH home: a session log changed within $TURN_WINDOW_HOURS whose last
# turn event is turn/start. Prints "<home>: <session id> since <time>".
live_turns() {  # $1 = DSH home
  local home=$1 files f last t
  [ -d "$home/sessions" ] || return 0
  # Fail closed: an unreadable log set must not read as "no open turns". Report on stderr and return
  # non-zero. Callers must capture the call and fail on a non-zero status, because a conditional or
  # pipeline caller would otherwise read the failure as no open turns.
  if ! command -v zstd >/dev/null 2>&1; then
    echo "live_turns: zstd is required to read DSH session logs (brew install zstd)" >&2
    return 1
  fi
  if ! files=$(find "$home/sessions" -name 'session.v*.jsonl.zstd' -mmin -$((TURN_WINDOW_HOURS * 60)) -print 2>/dev/null); then
    echo "live_turns: cannot list sessions under $home/sessions" >&2
    return 1
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # `|| true`: a live log may end in a partial frame and still yield its earlier lines.
    last=$({ zstd -dcq "$f" 2>/dev/null || true; } | { grep -E '^\{"type":"turn/(start|end)"' || true; } | tail -1)
    case $last in
      '{"type":"turn/start"'*)
        t=$(printf '%s' "$last" | sed -E 's/.*"time":([0-9]+).*/\1/')
        echo "$home: $(basename "$(dirname "$f")") since $(date -r $((t / 1000)) '+%F %T')" ;;
    esac
  done <<< "$files"
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
