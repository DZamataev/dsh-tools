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
