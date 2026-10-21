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
