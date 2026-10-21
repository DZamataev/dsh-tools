# dz-dsh-rollout: design

Date: 2026-10-21. Status: approved in chat, awaiting written-spec review.
Model: `dz-hermes-rollout` (`~/.hermes/skills/software-development/dz-hermes-rollout/`).

## Goal

Roll out the operator's DeepSeek Harness (DSH) fork to the Desktop app they work in every day,
through three gated steps (merge → verify → deploy), with an isolated test instance next to live.

- **Live**: `~/Applications/DeepSeek Harness.app`, home `~/.dsh` (profile `desktop`, sessions
  `~/.dsh/sessions`). Launched from `~/Applications` so macOS TCC grants (accessibility, screen
  recording, …) stay attached across rebuilds.
- **Test**: the verified build itself, home `~/.dsh-dev`, its own Electron userData, running next
  to live without touching live's data, sign-ins or sessions.
- **Integration branch** `develop` in the fork checkout `~/dev/deepseek-harness`; feature
  worktrees under `~/dev/deepseek-harness-wt/<name>`.

## Facts this design rests on (checked 2026-10-21)

| Fact | Value |
|---|---|
| Fork remote | `origin` = `git@github.com:DZamataev/deepseek-harness.git` |
| Upstream remote | `deepseek-ai` = `git@github.com:deepseek-ai/deepseek-harness.git`; `deepseek-ai/master` = `origin/master` = `687f282e86` |
| Feature branches | `feat/claude-code-relay` (1 commit `19f5f99fd2`, pushed, checked out in the main checkout, no worktree); `feat/composer-prediction` (23 commits, worktree `~/dev/deepseek-harness-wt/composer-prediction`, not pushed). No `develop` yet. |
| Current live | `pnpm run dev:desktop` build: `apps/desktop/.desktop-build/development/Harness Dev.app` (bundle id `com.deepseek.harness.dev.7841909f36fc`, ad-hoc signed), `DSH_HOME=~/.dsh`, userData `apps/desktop/.desktop-build/development/electron-user-data`, debug ports 9229/9222/9230. It executes the checkout's built `lib/` and `.desktop-build/targets/mac-arm64/runtime`, so any build in the checkout changes code under it. No watcher process; Electron is orphaned (ppid 1). |
| Home and profile | `DSH_HOME` (default `~/.dsh`); Desktop always uses profile `desktop` at `$DSH_HOME/profiles/desktop`. |
| Electron userData | Packaged default `~/Library/Application Support/@deepseek-ai/dsh-desktop`; `--user-data-dir=` overrides it (the dev launcher relies on this). The single-instance lock is per userData. |
| Ports | The Web Host listens on an OS-assigned port; packaged builds open no debug ports. |
| `dsh://` | The packaged app registers itself as the handler at every start. |
| Local package | `pnpm run package:desktop:mac:arm64:unsigned --dir`: unpacked app, appId `com.deepseek.harness`, ad-hoc signature, no update feed. |
| TCC | Ad-hoc signatures make TCC key grants on the cdhash, which changes on every build. The keychain has `Developer ID Application: Denis Zamataev (68QJJA7HK9)`; re-signing with it gives a designated requirement stable across builds. |
| Live home secrets | `.env`: four static API keys (TeamClaude, two codex-lb, opencode-go), shareable. `.credentials.yaml`: only `client-connection/browser-session`, per home. `mobile-access/`: devices and TLS. |
| Live profile plugin | `@local/dsh-provider-limits` → `link:/Users/frenzy/dev/dsh-plugins/provider-limits`. |
| Turn markers | `sessions/<project>/session-*/session.v4.jsonl.zstd`, one JSON envelope per line: `{"type":"turn/start",…}` / `{"type":"turn/end",…}`; `zstd -dc` reads a live file. |
| Skill roots | DSH reads `$DSH_HOME/skills` and `~/.agents/skills`. |
| Inside DSH | Agent shells carry `DSH_SESSION_ID`, `DSH_SHELL=1`, `DSH_PROFILE`, `DSH_PROFILE_DIR`, `DSH_HOME`, `DSH_WEB_URL`. |

## Decisions

1. **Build in a dedicated detached worktree, deploy the verified artifact.** The checkout only
   merges (git). `verify.sh` builds, tests and packages in `~/dev/deepseek-harness-wt/rollout-build`
   at the exact sha, and the test instance runs that very `.app`. `deploy.sh` installs the same
   bytes into `~/Applications` without rebuilding.
2. **Signing**: unsigned `--dir` package, then an inside-out re-sign with the Developer ID identity,
   without hardened runtime and without notarization (local files carry no quarantine).
3. **Cutover starts from a fresh userData**: the dev userData is not copied.
4. **Test home seed**: listed under *Test home seed* below; seeded once, refreshed by `--reseed`.
5. **Tests**: `typecheck` + `vitest run --changed <base>` + `build:check`; failures triaged against
   upstream as in Hermes.
6. **Home**: new repository `~/dev/dsh-tools` (local `git init`; a GitHub repository and pushes
   only on the operator's word). `~/dev/dsh-plugins` is retired: `provider-limits` is copied
   (without history) into `dsh-tools/plugins/`.

## Repository layout

```
dsh-tools/
  docs/specs/2026-10-21-dz-dsh-rollout-design.md
  skills/install.sh                 --target agents|claude|codex
  skills/dz-dsh-rollout/
    SKILL.md
    references/setup.md
    templates/config.sh
    scripts/{lib,state,merge,verify,deploy}.sh
    tests/run.sh
  plugins/provider-limits/
  plugins/install.sh                points profile link plugins at dsh-tools (post-deploy hook)
```

`install.sh` targets: `agents` → `~/.agents/skills` (seen by live and test DSH), `claude` →
`~/.claude/skills`, `codex` → `${CODEX_HOME:-~/.codex}/skills`. An existing copy is replaced only
with `--force`, after a backup.

## Configuration

`${XDG_CONFIG_HOME:-~/.config}/dz-dsh-rollout/config.sh`, sourced by `lib.sh`; environment
variables of the same name win over the file.

| Variable | Value for this machine | Meaning |
|---|---|---|
| `ROLLOUT_FORK` | `~/dev/deepseek-harness` | checkout holding `develop`; merges only |
| `ROLLOUT_BRANCH` | `develop` | integration branch |
| `ROLLOUT_WT_ROOT` | `~/dev/deepseek-harness-wt` | feature worktrees |
| `ROLLOUT_BUILD_WT` | `~/dev/deepseek-harness-wt/rollout-build` | detached build worktree, excluded from merge and push |
| `ROLLOUT_UPSTREAM` | `deepseek-ai/master` | merged by `merge.sh --upstream`; test-failure baseline |
| `ROLLOUT_PUSH_REMOTE` | `origin` | `deploy.sh --push` target |
| `ROLLOUT_LIVE_HOME` | `~/.dsh` | live DSH home |
| `ROLLOUT_TEST_HOME` | `~/.dsh-dev` | test DSH home |
| `ROLLOUT_APP` | `~/Applications/DeepSeek Harness.app` | live bundle |
| `ROLLOUT_SIGN_IDENTITY` | `Developer ID Application: Denis Zamataev (68QJJA7HK9)` | re-sign identity |
| `ROLLOUT_LEGACY_APP` | `~/dev/deepseek-harness/apps/desktop/.desktop-build/development/Harness Dev.app` | dev build quit during cutover; empty afterwards |
| `ROLLOUT_POST_DEPLOY` | `~/dev/dsh-tools/plugins/install.sh` | command run after install, app closed |
| `ROLLOUT_KEEP_ARTIFACTS` | `3` | verified artifacts kept besides the deployed one |

## State

- `~/.dsh/logs/rollout/verified`: `<sha> <date> tests=changed|full|none artifact=<path>`.
- `~/.dsh/logs/rollout/deployed`: `<sha> <date>`; the `vitest --changed` base. Before the first
  deploy the base is `git merge-base <sha> $ROLLOUT_UPSTREAM`.
- `~/.dsh/logs/rollout/*.log`: step logs (`verify-install.log`, `verify-tests-fork.log`,
  `verify-tests-rerun.log`, `verify-tests-upstream.log`, `verify-package.log`, `verify-sign.log`).
- `~/.dsh-dev/artifacts/<sha>/DeepSeek Harness.app`: signed artifacts.
- `~/.dsh-dev/electron-user-data/`, `~/.dsh-dev/instance.log`: test instance.

## Shared behavior (`lib.sh`)

- **Result line and notification**: every script ends with exactly one line
  `MERGE|VERIFY|DEPLOY|STATE OK: …` or `… FAILED: …` and posts `osascript display notification`
  (suppressed by `ROLLOUT_NO_NOTIFY=1`). An `EXIT` trap turns any unexpected exit into
  `FAILED: line N exited RC`. `--help` prints each script's header.
- **Inside DSH**: `inside_dsh` is true when `DSH_SESSION_ID` is set or `DSH_SHELL=1`. Only
  `deploy.sh` without `--dry-run` refuses there.
- **Processes by executable path** (`ps -axo pid=,comm=`, never `pgrep -f`):
  - live: `$ROLLOUT_APP/Contents/MacOS/*`;
  - test: `$ROLLOUT_TEST_HOME/artifacts/*/*.app/Contents/MacOS/*`;
  - legacy: `$ROLLOUT_LEGACY_APP/Contents/MacOS/Electron`.
  Helper processes live under `Contents/Frameworks/` and never match.
- **Live turns**: for each `session.v4.jsonl.zstd` under `<home>/sessions/` modified within the
  last 12 hours, the last line starting `{"type":"turn/start"` without a later line starting
  `{"type":"turn/end"` is an open turn. Prints `<home>: <session id> since <time>`.
- **Clean-branch check**: on `$ROLLOUT_BRANCH`, no tracked changes.
- **Worktree branches**: linked worktrees of `$ROLLOUT_FORK` under `$ROLLOUT_WT_ROOT`, excluding
  `$ROLLOUT_BUILD_WT` and detached ones.

## `state.sh` (read-only)

Prints `key=value` lines:

- `harness` (`dsh-desktop`, `claude-code`, `codex`, `unknown`) and `inside_dsh`;
- fork branch and sha;
- `develop` ahead/behind `$ROLLOUT_UPSTREAM`, and each worktree branch's commits ahead of `develop`;
- the `verified` and `deployed` stamps, and whether `verified` matches `develop`;
- the running live app (`app`, `legacy` or `none`) with its pid, and whether `$ROLLOUT_APP` exists;
- whether the test instance runs, and its sha;
- open turns in both homes;
- `mode`:
  - `initial-setup`: no config or no `develop`;
  - `cutover`: `$ROLLOUT_APP` absent, or the legacy dev app running;
  - `rollout`: otherwise.

## `merge.sh [--dry-run] [--upstream]`

Git only, in `$ROLLOUT_FORK`; behavior of the Hermes script:

- Preconditions: on `develop`, clean.
- `--upstream`: `git fetch deepseek-ai`, then `merge --no-ff -m "Merge deepseek-ai/master into develop"`.
- Then every worktree branch with commits ahead of `develop`: `merge --no-ff -m "merge: <branch> into develop"`.
  - `--dry-run` prints `to merge: <branch> (+N)` plus the branch's own commits over upstream, so a
    worktree branched from a newer upstream is visible as an upstream merge.
  - A branch with uncommitted changes is merged with a warning (commits only).
- A conflict runs `merge --abort`, keeps earlier merges, stops with the branch named.
- No build or smoke in the checkout.

## `verify.sh [--full|--no-tests] [--since REF] [--reseed] [--no-app] [--stop]`

All work happens in `$ROLLOUT_BUILD_WT`; the checkout and live stay untouched, so an agent inside
DSH may run it.

1. **Preconditions**: config, `develop` clean, `SHA=$(git rev-parse develop)`.
   - Create the build worktree when missing (`git worktree add --detach $ROLLOUT_BUILD_WT $SHA`),
     else `checkout --detach $SHA`.
   - Tracked files must be clean.
2. **Dependencies**: `pnpm install --frozen-lockfile`, then `pnpm run build:native-system`.
3. **Tests** (skipped by `--no-tests`, recorded `tests=none`):
   - `pnpm run typecheck`;
   - `vitest run --changed <base>`, where base is `--since`, else `deployed`, else the upstream
     merge-base; `--full` runs the whole suite.
   - Failing files are rerun one by one. Files still failing are rerun on
     `git merge-base $SHA $ROLLOUT_UPSTREAM` in the same worktree (checkout, `pnpm install
     --frozen-lockfile`, those files only, checkout back to `$SHA`, install again).
   - Only failures absent upstream are ours: `FAILED` lists them with log paths.
4. **Package**: `pnpm run package:desktop:mac:arm64:unsigned --dir`, locate the unpacked `.app`
   under `apps/desktop/.desktop-build/targets/mac-arm64/`, then `pnpm run build:check`.
5. **Sign**:
   - Re-sign inside-out with `$ROLLOUT_SIGN_IDENTITY`, `--force`, no `--options runtime`: nested
     Mach-O files, then helpers and frameworks, then the bundle.
   - `codesign --verify --deep --strict` must pass.
   - The designated requirement must name `identifier "com.deepseek.harness"` and the certificate
     OU `68QJJA7HK9`.
   - The first run doubles as the spike for this step: when the re-signed app does not launch, stop
     and report.
6. **Artifact**: `ditto` into `$ROLLOUT_TEST_HOME/artifacts/$SHA/`. Prune to
   `$ROLLOUT_KEEP_ARTIFACTS` plus the deployed sha.
7. **Seed** `$ROLLOUT_TEST_HOME` (first run or `--reseed`; see below).
8. **Test instance** (skipped by `--no-app`, recorded `app=false`; the artifact is still built,
   so the sha stays deployable). `<exe>` is the bundle's `CFBundleExecutable`:
   - Stop the previous one.
   - Launch `env -u` every `DSH_*` and `ELECTRON_*` variable, plus `DSH_HOME=$ROLLOUT_TEST_HOME`:
     `nohup "<artifact>/Contents/MacOS/<exe>" --user-data-dir=$ROLLOUT_TEST_HOME/electron-user-data`
     with output to `instance.log`, disowned. Clearing the environment is required: from an agent
     inside live it would otherwise inherit `DSH_PROFILE_DIR=~/.dsh/profiles/desktop`.
   - Wait up to 120 s until the process at the artifact path listens on TCP. An exit or timeout is
     `FAILED` naming `instance.log`.
9. **Stamp**: write `verified`. Result line:
   `VERIFY OK: develop <short sha> verified (tests=…, app=…). Check the test window, then deploy.sh [--push]; stop it with verify.sh --stop`.

`--stop`: TERM every test-instance process by path, wait 30 s, else `FAILED`.

### Test home seed

| Copied from `~/.dsh` | Not copied |
|---|---|
| `.env` (mode 600) | `.credentials.yaml` (per-home browser-session secret) |
| `cordis.patch.yml` (machine MCP servers) | `mobile-access/` (devices, TLS) |
| `storages/workspace.json` (project list) | `sessions/`, `attachments/`, `logs/`, `storages/session_projcache*` |
| `profiles/desktop/{cordis.patch.yml, package.json, pnpm-lock.yaml, pnpm-workspace.yaml}` | `.anonymous-user-id` |
| `profiles/desktop/node_modules` (`cp -a`; relative links resolve at the same depth) | `profiles/{web,web-mobile,headless}`, `profiles/node_modules`, `settings.yaml.*` |

An existing seed is kept unless `--reseed`; `.credentials.yaml` is never copied, even then.

## `deploy.sh [--dry-run] [--push] [--unverified] [--ignore-live-turns] [--no-relaunch]`

1. **Preconditions**, before any side effect:
   - Inside DSH without `--dry-run`: print the absolute command for an outside terminal, `FAILED`.
   - `develop` clean.
   - `develop` sha equals the `verified` sha; otherwise refuse (`--unverified` only on the
     operator's word). The dry run warns instead.
   - The artifact exists and passes `codesign --verify --deep --strict`.
2. **Live turns** in `~/.dsh` and `~/.dsh-dev`: open turns refuse the deploy
   (`--ignore-live-turns` only on the operator's word). The dry run lists them.
3. **Dry run**:
   - prints the plan (quit, install, hook, relaunch, pushes);
   - inside DSH, also the command the operator runs;
   - then `DEPLOY OK: dry run`.
4. **`--push`**: `git push origin develop`; a failure stops with nothing deployed.
5. **Quit**:
   - `verify.sh --stop`.
   - For `$ROLLOUT_APP` and `$ROLLOUT_LEGACY_APP` when running:
     `osascript -e 'tell application "<bundle path>" to quit'`. This is the ordinary quit, so the app
     asks for confirmation itself while tasks run.
   - Wait 120 s per app. A process still alive (the operator chose Cancel) is `FAILED` with nothing
     installed.
6. **Install**:
   - `ditto` the artifact to `$ROLLOUT_APP.new`;
   - rename the current bundle to `$ROLLOUT_APP.old`;
   - rename `.new` into place;
   - remove `.old`.
   A failure after the first rename restores `.old`.
7. **Post-deploy hook**: `$ROLLOUT_POST_DEPLOY` with `ROLLOUT_LIVE_HOME`, `ROLLOUT_TEST_HOME` and
   `ROLLOUT_APP` in its environment; a failure is `FAILED` after install (the app stays closed).
8. **Stamp** `deployed`; `open "$ROLLOUT_APP"` unless `--no-relaunch`. Opening re-registers `dsh://`.
9. **`--push`**: push every worktree branch to `origin`, never forced. A rejection is reported in
   the result line, not fatal.

Result: `DEPLOY OK: live <short sha>[, develop pushed][, worktree branches pushed|WARNING …]`.

## `plugins/install.sh`

- For each of `$ROLLOUT_LIVE_HOME` and `$ROLLOUT_TEST_HOME` with a `profiles/desktop/package.json`,
  point every `link:` dependency on `~/dev/dsh-plugins/<name>` at `~/dev/dsh-tools/plugins/<name>`.
- Reinstall the profile with the bundled pnpm of `$ROLLOUT_APP`
  (`Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`, run with the app's
  Node). The implementation plan's first task proves the exact invocation against a copy of the
  live profile before the hook is written.
- Idempotent: a profile already pointing at dsh-tools is left as is. Runs only while the app is closed.

## Initial setup (`references/setup.md`)

Every step with side effects waits for the operator's yes.

1. Fill `~/dev/dsh-tools`:
   - the skill and `skills/install.sh --target agents`;
   - copy `~/dev/dsh-plugins/provider-limits` (with `lib/` and `node_modules`) to
     `plugins/provider-limits`;
   - replace `~/dev/dsh-plugins/provider-limits` with a symlink to it (the running live already
     loaded the plugin; its next start follows the link).
2. Copy `templates/config.sh` to `~/.config/dz-dsh-rollout/config.sh` with the values above.
3. Create `develop`:
   - `git branch develop deepseek-ai/master`, then `git switch develop` in the checkout (clean, no
     watcher, built `lib/` unchanged);
   - one-time `merge --no-ff feat/claude-code-relay` (no worktree, so `merge.sh` cannot see it);
   - `merge.sh --dry-run`, then `merge.sh` merges `feat/composer-prediction`.
4. First `verify.sh` (the agent may run it). It creates the build worktree. The first install and
   package take long; this run also settles the signing spike.
5. The operator checks the test window:
   - a normal chat over TeamClaude (`claudeCodeVersion` in effect, no 429);
   - composer prediction;
   - the provider-limits chip.
6. **Cutover** = first deploy, run by the operator from Terminal or Ghostty (not a DSH terminal).
   - It quits `Harness Dev.app`, installs `~/Applications/DeepSeek Harness.app`, runs the hook,
     opens the app.
   - The operator grants TCC once.
   - Check: `~/.dsh` sessions visible, plugin loaded, designated requirement, stamps; then clear
     `ROLLOUT_LEGACY_APP`.
   - Fallback: `DSH_HOME=~/.dsh pnpm run start:desktop` in the checkout, which reuses the existing
     build.
7. Archive `DZamataev/dsh-plugins` on GitHub and delete `~/dev/dsh-plugins`, on the operator's word.

## Rules (SKILL.md)

- Push only on the operator's explicit word; never force-push without it.
- Deploy from inside DSH prints the command; the operator runs it outside after their turns end.
- Worktrees only on the operator's permission, at `~/dev/<project>-wt/<name>`; the build worktree
  path above is approved.
- Never `pnpm` build in `$ROLLOUT_FORK` while live runs from it (until cutover).
- In-app updates do not apply: unsigned packages carry no update feed.

## Test bench (`tests/run.sh`)

A mktemp sandbox; it never starts or quits a real app.

- merge: dry run, merge, `--upstream`, conflict and abort, exclusion of the build worktree and
  detached worktrees, environment over config file.
- deploy preconditions:
  - refusal of an unverified sha and of a dirty fork;
  - refusal under `DSH_SESSION_ID` and `DSH_SHELL=1`, printing the absolute command;
  - dry run working inside DSH;
  - a missing or invalid artifact.
- live turns from synthetic `session.v4.jsonl.zstd`: open, closed, older than 12 h; both homes.
- processes by path: a fake bundle executable symlinked to `/bin/sleep` is found and quit; another
  path is not.
- seed: allowed files copied; `.credentials.yaml`, `mobile-access/` and `sessions/` absent.
- `state.sh`: modes `initial-setup`, `cutover`, `rollout`; harness detection.
- `install.sh`: every target into a fake `HOME`.

## Known consequences

- The first launch of the Developer ID-signed app asks for TCC grants again (new signer). They
  persist while the certificate stays the same.
- The test instance claims `dsh://` while it runs; the live relaunch after deploy reclaims it.
- Two bundles share `com.deepseek.harness` (live and the test artifact). TCC grants are shared,
  because the signer is the same.
