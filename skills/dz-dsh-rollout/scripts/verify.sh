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
[ "$prev" != --since ] || fail "--since needs a REF"

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
# A stamp is evidence for one build; rebuilding this sha invalidates it until this run ends well.
if [ -f "$VERIFIED" ] && [ "$(cut -d' ' -f1 "$VERIFIED")" = "$SHA" ]; then
  rm -f "$VERIFIED"
  echo "previous verified stamp for $SHORT cleared"
fi

step "build worktree $BUILD_WT at $SHORT"
if [ ! -e "$BUILD_WT/.git" ]; then
  git -C "$FORK" worktree add -q --detach "$BUILD_WT" "$SHA" || fail "could not create $BUILD_WT"
else
  [ -z "$(git -C "$BUILD_WT" status --porcelain --untracked-files=no)" ] \
    || fail "$BUILD_WT has tracked changes — inspect them and reset the worktree by hand"
  git -C "$BUILD_WT" checkout -q --detach "$SHA" || fail "checkout of $SHORT in $BUILD_WT failed"
fi
# shellcheck disable=SC2046  # one -u NAME pair per word
# Builds and tests get a throwaway DSH_HOME: code that falls back to ~/.dsh must not touch live.
RUN_HOME=$(mktemp -d)
bw() { (cd "$BUILD_WT" && env $(dsh_env_unset) DSH_HOME="$RUN_HOME" "$@"); }
INSTALL_LOG=$STATE_DIR/verify-install.log
install_deps() {
  bw pnpm install --frozen-lockfile >>"$INSTALL_LOG" 2>&1 || fail "pnpm install failed — see $INSTALL_LOG"
  bw pnpm run build:native-system >>"$INSTALL_LOG" 2>&1 || fail "build:native-system failed — see $INSTALL_LOG"
}
step "dependencies"
: >"$INSTALL_LOG"
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
NO_FAILURE_ID="(failed without a test failure)"
# Failure ids of one single-file rerun: $1 file, $2 its report, $3 its vitest exit code. A report
# with failed tests yields those ids; a non-zero exit or a missing/empty report that yields none
# yields "<file> $NO_FAILURE_ID", so a failed rerun always contributes an id.
rerun_ids() {
  local ids=""
  if [ -s "$2" ]; then ids=$(failed_ids "$2") || return 1; fi
  if [ -z "$ids" ] && { [ ! -s "$2" ] || [ "$3" -ne 0 ]; }; then ids="$1 $NO_FAILURE_ID"; fi
  [ -z "$ids" ] || printf '%s\n' "$ids"
}

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
    files=$(failed_ids "$FJSON" | files_of) || fail "unreadable vitest report $FJSON — see $FLOG"
    [ -n "$files" ] || fail "vitest exited $rc without a failure list — see $FLOG"
    step "rerun $(echo "$files" | wc -l | tr -d ' ') failing file(s) one by one"
    RLOG=$STATE_DIR/verify-tests-rerun.log; : >"$RLOG"
    fork_ids=""; i=0
    for f in $files; do
      i=$((i + 1)); out=$STATE_DIR/verify-tests-rerun-$i.json
      rc=0
      bw pnpm exec vitest run "$f" --reporter=json --outputFile.json="$out" >>"$RLOG" 2>&1 || rc=$?
      ids=$(rerun_ids "$f" "$out" "$rc") || fail "unreadable vitest report $out — see $RLOG"
      fork_ids="$fork_ids$ids"$'\n'
    done
    fork_fail=$(printf '%s' "$fork_ids" | sed '/^$/d' | sort -u)
    if [ -z "$fork_fail" ]; then
      echo "all pass alone: parallel-run flakes"
    else
      [ -n "$UPBASE" ] || fail "no merge-base with $UPSTREAM, so every failure is ours: $(echo "$fork_fail" | wc -l | tr -d ' ') — see $RLOG"
      step "rerun on upstream $(git -C "$FORK" rev-parse --short "$UPBASE")"
      ULOG=$STATE_DIR/verify-tests-upstream.log; : >"$ULOG"
      git -C "$BUILD_WT" checkout -q --detach "$UPBASE" || fail "checkout of the upstream base in $BUILD_WT failed"
      install_deps
      up_ids=""; i=0
      for f in $(echo "$fork_fail" | files_of); do
        [ -f "$f" ] || continue   # a test file the fork added fails only on the fork
        i=$((i + 1)); out=$STATE_DIR/verify-tests-upstream-$i.json
        rc=0
        bw pnpm exec vitest run "$f" --reporter=json --outputFile.json="$out" >>"$ULOG" 2>&1 || rc=$?
        ids=$(rerun_ids "$f" "$out" "$rc") || fail "unreadable vitest report $out — see $ULOG"
        up_ids="$up_ids$ids"$'\n'
      done
      git -C "$BUILD_WT" checkout -q --detach "$SHA" || fail "checkout back to $SHORT in $BUILD_WT failed"
      install_deps
      up_fail=$(printf '%s' "$up_ids" | sed '/^$/d' | sort -u)
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
BUILT=$({ find "$TARGETS" -maxdepth 4 -type d -name "$APP_NAME" 2>/dev/null || true; } | head -1)
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
  # SingletonLock is a dangling symlink ("host-pid"), so -e alone would reject a live lock.
  { [ -L "$TEST_HOME/electron-user-data/SingletonLock" ] || [ -e "$TEST_HOME/electron-user-data/SingletonLock" ]; } \
    || fail "the test instance ignored --user-data-dir and would share live's single-instance lock — see $ILOG"
  echo "test instance up: $ART; DSH_HOME=$TEST_HOME; userData $TEST_HOME/electron-user-data"
fi

rm -rf "$RUN_HOME"
echo "$SHA $(date '+%F %T') tests=$tests app=$app artifact=$ART" >"$VERIFIED"
ok "$BRANCH $SHORT verified (tests=$tests, app=$app). Check the test window, then: deploy.sh [--push]; stop it with verify.sh --stop"
