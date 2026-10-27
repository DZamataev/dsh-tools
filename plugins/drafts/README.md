# @local/dsh-drafts

A DSH Web UI plugin. On the New Session page it adds a compact **Черновики (N)** / **Drafts (N)** button to the New Session row (slot `conversation.hero.options`). The button opens a list of other blank Sessions that hold an unsent composer draft.

- A row shows the first non-empty line of the draft, the Workspace when it differs from the current one, and the relative time of the Session (`updatedAt`).
- Clicking a row calls `uiWorkspace.openSession(id)`; the composer of that Session restores its own draft.
- The trash button calls `uiWorkspace.archiveSession(id)`, the same operation as the sidebar's Archive; `uiWorkspace.unarchiveSession(id)` reverses it. While the call is pending the button ignores clicks and keeps focus; after the row disappears, focus moves to the row now at its position. Archiving the last draft removes the button itself, so focus returns to the page.
- Without drafts nothing renders.

## Data sources

| Fact | Source |
|---|---|
| Blank flag, `cwd`, `updatedAt`, Host list order | slot hook `useSessions` (`ids`, `byId`) |
| Workspace membership and titles, archive set | slot hook `useWorkspaces` (`items`, `archivedSessionIds`) |
| Draft text | `localStorage["dsh.conversation.<sessionId>"].draft`: a string (legacy) or `{ text, references, command? }`; read only |

A structured draft is listed only when it passes the same checks as ui-conversation `parseStoredDraft` (complete reference fields, ordered reference spans that match `text`, a leading `/command` token that `text` starts with); DSH restores any other value as an empty composer. References are inline mentions inside `text`, so a draft counts as empty exactly when its text is blank.

The current Session, archived Sessions, subagent Sessions, and empty or unrestorable drafts are excluded. The list re-reads storage when the menu opens, when the Session or Workspace list changes, when the page becomes visible, and on `storage` events from other tabs.

## Files

- `client.js`: browser module registered through `window.__ModuleLoader__`; injects `slots`, `locale`, `uiWorkspace`.
- `index.js`: empty Host half.
- `cordis.patch.yml`: inserts the `dsh-drafts` row.
- `locale/{en,ru,zh}.json`: Plugin Manager title and description. UI strings live in `client.js` dictionaries (en, zh, ru) under the `dsh-drafts` locale namespace.
- `tests/client.test.mjs`: jsdom behavior test with real React; run `node --test tests/` (needs a DSH source checkout at `~/dev/deepseek-harness` or `DSH_REPO`).

## Install, disable, remove

The bundle is installed by link, so this directory must stay in place. `plugins/install.sh`, which every dz-dsh-rollout deploy runs, connects it to the live and test Desktop profiles like the other plugins here.

- Install: `plugin_manager install_bundle` with target `~/dev/dsh-tools/plugins/drafts`, or `dsh plugin --profile desktop add link:~/dev/dsh-tools/plugins/drafts`.
- Disable without removing: Settings → Plugins, toggle **Drafts**; or `plugin_manager set_bundle` with target `@local/dsh-drafts` and `enabled: false`.
- Remove: Settings → Plugins → remove; or `plugin_manager remove_bundle` with target `@local/dsh-drafts`.

After editing `client.js`, restart DSH: the Web server serves each module revision as immutable, so a page reload alone keeps the old code.

## Known limitations

- Russian UI text appears only when the active DSH language is `ru`; DSH ships `en` and `zh`, so without a Russian language pack the button reads in English.
- Drafts live in the browser's `localStorage`, so another browser or the Desktop window versus a Web tab each see only their own drafts.
- A blank Session whose Workspace was deleted still appears and opens; its Workspace label falls back to the directory name.
- At startup DSH reopens the last selected blank Session through a path that refreshes its projections and recorded Agent preset; `openSession` does not do that, so after a DSH restart a reopened draft Session may start under the default preset.
- Archived blank Sessions keep their `localStorage` entry; the plugin never deletes or rewrites drafts.
