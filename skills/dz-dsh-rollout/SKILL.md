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
     their confirmation. A feature shipped as an optional bundle (an `experimental/*-bundle`
     package) is off in the seeded test profile, as in live: the checklist starts with switching
     it on in Plugins → More, and states its own preconditions (composer prediction needs two
     assistant replies). No record of the feature in the Session log means it is not mounted.
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
   - Afterwards check: compare `deployed` from `state.sh` with `git -C <fork> rev-parse develop`;
     `live=app` after the relaunch; `codesign -d -r-` of the app names the team; the operator's
     chat works. Report the deployed sha.

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
`deployed` → profile setup (`ROLLOUT_PROFILE_SETUP`, default dsh-tools `presets/team-pair/apply.sh`:
Team mode, Codex mode, Codex teammate mode) → post-deploy hook (`plugins/install.sh`: profile link
plugins, missing dsh-tools plugins connected, bundled pnpm) → open the app → `--push` worktree branches. verify.sh runs the same profile
setup and then the post-deploy hook with `ROLLOUT_HOOK_SCOPE=test` (test home only, the artifact's
bundled pnpm; live may stay open) on the test home before it starts the test instance, so a new
dsh-tools plugin reaches the test window on the next verify.

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
  `plugins/install.sh` (deploy runs it for both homes, verify for the test home).
- **`zstd` is required.** Open turns are read from `session.v*.jsonl.zstd`, and deploy reads them
  only for the windows it closes; without `zstd` on PATH, deploy refuses ("cannot read open turns")
  when it must read a home, and state.sh prints `open_turns=unknown` (`brew install zstd`).
- **An unfinished plugin relink** leaves `profiles/desktop/package.json.dz-relink.bak` in the live
  or test home; the next `plugins/install.sh` restores it only when package.json is still exactly
  its own rewrite, and otherwise stops with "changed after an unfinished relink": compare the two
  files, keep the right one, remove the backup, run the hook again.
- **A failed post-deploy hook** leaves the new app installed and closed. Fix the profile, run
  `~/dev/dsh-tools/plugins/install.sh` (a path in the dsh-tools repository, not in the skill), then
  open the app. No second deploy is needed.
- **Never run `verify.sh` from an agent inside the test window**: it stops the test instance, which
  is that agent's own host.
- **"another DSH Desktop still runs"** (deploy) and `plugins/install.sh: a DSH Desktop is running`:
  a DSH Desktop other than `ROLLOUT_APP` and the legacy build holds the home. Quit it and run the
  command again; `state.sh` names such bundles in `other_desktops`.
- **The Automation prompt**: the first quit makes macOS ask whether the terminal may control the app
  ("Harness Dev", later "DeepSeek Harness"). Refusing, or an earlier refusal, fails the deploy with
  "macOS refused the Apple event" and nothing installed: allow the terminal in System Settings →
  Privacy & Security → Automation, then deploy again.
- **Fixing these scripts**: edit `~/dev/dsh-tools/skills/dz-dsh-rollout/`, run `bash -n` and
  `tests/run.sh`, reinstall with `skills/install.sh --target agents --force dz-dsh-rollout`, commit
  in dsh-tools; push only on the operator's word.
