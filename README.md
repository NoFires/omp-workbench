# omp-workbench

A session workbench for [omp](https://omp.sh): an all-project session browser, guarded automation, rewind, thinking controls, and safety gates in one extension.

## Features

- **Agents view** — `←` or `Alt+A` on an empty composer, or `/sessions-view`. Browse sessions by directory (current directory first) or state with a summary header bar, color-coded status glyphs, aligned columns, cached message peek, attach, new session, instant archive with persistent undo (`u` / `Ctrl+R` / `/undo-archive`), and live filtering.
- **Composer shortcuts** — `Shift+Tab` cycles Yolo → Auto → Plan; `Shift+↑` / `Shift+↓` changes the thinking level; `Esc Esc` opens rewind on an empty idle composer.
- **Auto mode** — classifier-gated approval for non-trivial shell commands and writes outside the workspace. `/auto-mode` controls the mode, including a hard `readonly` lock.
- **Rewind** — `/checkpoint` or `Esc Esc` restores file checkpoints and/or the conversation branch. File backups live under `~/.omp/agent/file-history/`.
- **Thinking preview** — thinking streams while the turn is active and folds afterward; the final reply carries a short `↳` preview.
- **Safety layers** — destructive shell command denial, protected credential-path writes, and tool-output secret redaction. `/policy` shows counters.

## Install

From a checkout:

```sh
omp plugin link /path/to/omp-workbench
```

Then restart omp.

The package entry is `index.ts` and declares its extension in `package.json`:

```json
{
  "omp": {
    "extensions": ["./index.ts"]
  }
}
```

## Development

Requires Node.js 24+. The tests use `node:test` and run straight from TypeScript:

```sh
npm test
```

## Configuration

Recommended keybindings:

```yaml
# ~/.omp/agent/keybindings.yml
app.plan.toggle: Alt+Shift+P
app.thinking.cycle: []
app.message.dequeue: Alt+Up
```

Let the workbench own the double-Escape gesture:

```yaml
# ~/.omp/agent/config.yml
doubleEscapeAction: none
```

Auto mode uses the `guard` model role for its classifier. Pin a fast model when the default is too slow:

```yaml
modelRoles:
  guard: <provider>/<fast-model>
```

Rewind uses `~/.omp/agent/better-pi-rewind.json` for its escape window:

```json
{
  "activeRunEscapePresses": 1,
  "escapeWindowMs": 1500
}
```

## Commands and keys

| Action | Key / command |
|---|---|
| Open agents view | `←` / `Alt+A` / `/sessions-view` |
| Attach / open selected session | `Enter` / `→` |
| Preview selected session | `Space` |
| New session | `n` in agents view |
| Archive session immediately (stops running current session first) | `Ctrl+X` in agents view |
| Undo last archive | `u` / `Ctrl+R` in agents view, or `/undo-archive` |
| Filter sessions | type in agents view |
| Cycle mode | `Shift+Tab` |
| Open rewind | `Esc Esc` / `/checkpoint` |
| Cycle thinking level | `Shift+↑` / `Shift+↓` |
| Auto mode controls | `/auto-mode` |
| Policy counters | `/policy` |

## Safety

The tool gate runs deterministic checks before any classifier call:

1. destructive shell patterns
2. protected credential paths
3. read-only or pending-plan locks
4. instruction veto
5. classifier verdict

Redaction is applied to tool results before they reach the model or persisted transcript. This is defense in depth, not a sandbox: shell commands still run with the user's ambient permissions once allowed.

## Limitations

- Auto mode depends on a classifier model; if it is unavailable, guarded actions are refused rather than silently allowed.
- Rewind restores files tracked through edit/write checkpointing. Changes made only by arbitrary shell commands or external editors are not tracked.
- The agents view is a local session browser. Other sessions are not backed by a background process supervisor.

## Source layout

```text
index.ts            extension entry and gate order
src/agents-view.ts  fullscreen session browser
src/agents-format.ts pure formatting helpers
src/archive-store.ts archive backup & undo history
src/input-router.ts composer key routing
src/auto-mode.ts    classifier and mode state
src/classifier.ts   classifier protocol
src/policy.ts       protected paths and policy counters
src/guard.ts        destructive shell denial
src/redact.ts       tool-output secret redaction
src/thinking.ts     thinking-level controls and preview
src/rewind/         file checkpoint and restore
src/session-files.ts session transcript helpers
src/tool-input.ts   shared tool argument parsing
src/shell.ts        shell command parsing
test/               unit tests
```
