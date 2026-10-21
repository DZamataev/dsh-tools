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
if [ -z "$SIGN_IDENTITY" ]; then
  warn_or_fail "ROLLOUT_SIGN_IDENTITY is not set"
elif [ -d "$ART" ] && codesign --verify --deep --strict "$ART" 2>/dev/null; then
  if requirement_ok "$ART" "$SIGN_IDENTITY"; then
    echo "artifact: $ART"
  else
    warn_or_fail "artifact $ART is not signed by $SIGN_IDENTITY (run verify.sh)"
  fi
else
  warn_or_fail "no valid artifact for $short at $ART (run verify.sh)"
fi
# The first deploy (no $APP yet) must quit the dev build that runs live: it has to be named.
if [ ! -e "$APP" ] && { [ -z "$LEGACY_APP" ] || [ ! -d "$LEGACY_APP" ] || [[ "$LEGACY_APP" != *.app ]]; }; then
  running=$(desktop_pids | head -1 | cut -d' ' -f2-)
  if [ -n "$running" ]; then
    warn_or_fail "a DSH Desktop runs ($running) but ROLLOUT_LEGACY_APP does not name it — set it in the config"
  fi
fi
old=$(cut -d' ' -f1 "$DEPLOYED" 2>/dev/null || true)
echo "live $(git -C "$FORK" rev-parse --short "$old" 2>/dev/null || echo none) → $short"

# Turns die with the window that runs them: check the homes of the windows deploy closes.
# Each call is captured and checked: a failed read must not pass as "no open turns".
live=""
if [ -n "$(bundle_pids "$APP")" ] || [ -n "$(bundle_pids "$LEGACY_APP")" ]; then
  if ! t=$(live_turns "$LIVE_HOME"); then fail "cannot read open turns in $LIVE_HOME (see the message above)"; fi
  live+="$t"$'\n'
fi
if [ -n "$(test_instance_pids)" ]; then
  if ! t=$(live_turns "$TEST_HOME"); then fail "cannot read open turns in $TEST_HOME (see the message above)"; fi
  live+="$t"
fi
live=$(echo "$live" | sed '/^$/d')
if [ -n "$live" ]; then
  echo "running turns:"; echo "$live" | sed 's/^/  /'
  msg="$(echo "$live" | wc -l | tr -d ' ') turn(s) still running in a DSH window deploy would close"
  if $dry_run || $ignore_live; then echo "WARNING: $msg"; else fail "$msg (wait for them, or --ignore-live-turns)"; fi
fi

if $dry_run; then
  if $push; then echo "would run: git -C $FORK push $PUSH_REMOTE $BRANCH; after the deploy: git -C $FORK push $PUSH_REMOTE $(wt_branches | cut -f2 | xargs)"; fi
  while IFS= read -r b; do echo "WARNING: another DSH Desktop runs: $b"; done < <(other_desktop_bundles)
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
remaining=$(desktop_pids | head -1)
if [ -n "$remaining" ]; then
  fail "another DSH Desktop still runs: ${remaining#* } (pid ${remaining%% *}) — quit it, then deploy again; nothing installed"
fi

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
  # shellcheck disable=SC2046  # one -u NAME pair per word
  env $(dsh_env_unset) open "$APP"   # ELECTRON_RUN_AS_NODE from an editor terminal would start the app as plain node
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
