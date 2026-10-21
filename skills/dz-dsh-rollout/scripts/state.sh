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
# Not `env | grep -q`: under pipefail, grep exiting early can make env fail with SIGPIPE.
elif [ -n "$(env | grep '^CODEX_' || true)" ]; then harness=codex
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

# Each home is read separately: a failed read must not read as zero open turns.
turns=""; turns_ok=yes
for H in "$LIVE_HOME" "$TEST_HOME"; do
  if ! t=$(live_turns "$H"); then turns_ok=no; fi
  if [ -n "$t" ]; then turns="${turns:+$turns$'\n'}$t"; fi
done

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
if [ -n "$turns" ]; then printf '%s\n' "$turns" | sed 's/^/open_turn=/'; fi
if [ $turns_ok = yes ]; then
  open_n=0
  if [ -n "$turns" ]; then open_n=$(printf '%s\n' "$turns" | wc -l | tr -d ' '); fi
  echo "open_turns=$open_n"
else
  echo "open_turns=unknown"
fi
echo "config=$config"
echo "config_file=$ROLLOUT_CONFIG"
echo "mode=$mode"
ok "mode=$mode"
