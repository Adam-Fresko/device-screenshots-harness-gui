# AGENTS.md

Instructions for coding agents (Codex, Claude Code, any other) working in this repo. `CLAUDE.md` imports this file, so edit this one.

This repo holds mods (plugins) for AI coding harnesses: Claude Code and Codex today. Each app has a folder of mods and a marketplace file, so users install any mod straight from the GitHub repo `Adam-Fresko/mods-harness-gui`. The marketplace name is `mods-harness-gui` for both apps.

## Layout

```
.claude-plugin/marketplace.json    Claude Code marketplace: one entry per mods/claude-code/<mod>
.agents/plugins/marketplace.json   Codex marketplace: one entry per mods/codex/<mod>
mods/
  claude-code/<mod>/               one Claude Code plugin
  codex/<mod>/                     one Codex plugin
templates/
  claude-code/                     what `scripts/mods.py new claude-code` copies
  codex/                           what `scripts/mods.py new codex` copies
scripts/mods.py                    `new` scaffolds a mod, `check` checks every mod
AGENTS.md                          this file
CLAUDE.md                          imports AGENTS.md
```

## Rules for every mod

1. **One mod, one folder:** `mods/<app>/<mod-name>/`. The name is kebab-case and is the same in three places: the folder, the manifest's `name`, and the marketplace entry's `name`.
2. **Scaffold with the script, not by hand.** It copies the template, fills in the name and description, and adds the marketplace entry:
   ```bash
   python3 scripts/mods.py new <claude-code|codex> <mod-name> -d "One line about what it does."
   ```
3. **Keep each mod self-contained.** Installing a mod copies only its own folder, so a mod never imports, links or reads files outside it (no `../../shared`). If two mods need the same code, copy it into both.
4. **One feature on both apps:** use the same mod name under `mods/claude-code/` and `mods/codex/`, and link the two READMEs to each other. The two are separate implementations. They share no files.
5. **Each mod has a `README.md`** that says what it does, how to install it, and how to use it (commands, skills, settings). When you add, rename or remove a mod, update the Mods table in the root `README.md` too.
6. **Bump `version`** in the mod's manifest (semver) when its behaviour changes. Codex caches installs by version, and users update by version.
7. **To remove a mod,** delete its folder and its marketplace entry in the same change.
8. **Don't commit generated files.** Claude Code lays type declarations into `mods/claude-code/<mod>/.claude-plugin/types/` whenever it loads a mod. That folder is gitignored.
9. **Before you finish,** run `python3 scripts/mods.py check` and get `ok`. Add `--run-claude` when you touched a Claude Code mod; it also runs `claude plugin validate` and `claude plugin test` on each one.

## Claude Code mods (`mods/claude-code/<mod>/`)

A Claude Code mod is a plugin made of function hooks: one TypeScript module that hooks the engine's events and draws UI with JSX.

```
.claude-plugin/plugin.json   name, version, description, author; plus "types": "./types/index.d.ts" if it has a state contract
hooks/hooks.json             { "modules": ["./register.tsx"] }: exactly one path, relative to this file
hooks/register.tsx           export const register: Register = (on, options) => { ... }
types/index.d.ts             only when the mod keeps values in $.state (see below)
tests/*.test.ts              run by `claude plugin test`; import test, expect, mock from 'claude-code/testing'
tsconfig.json                from the template; leave it as is
README.md
```

### How the API works

The API is early access and changes between releases. Use the type declarations as the reference (see the Types section below), not memory. The basics:

- `on(event, matcher?, hook)` adds a hook. Every hook is `($, e, next)`. `$` is the engine, `e` is the event's frozen input, and `next(e)` runs the plugins beneath and then the engine's own behaviour. A hook can pass the event through with `next(e)`, rewrite it with `next({ ...e, field })`, or answer it alone by returning without calling `next`.
- The module runs in an isolated environment: no DOM, no Node, no `require`, no dynamic `import()`. Static `import` of the mod's own files is fine. Everything outside the module goes through `$`: `$.fs`, `$.process`, `$.ui`, `$.state`, `$.store`, `$.model`, `$.tool`, `$.agent`, `$.command`, `$.clock` and the rest.
- JSX compiles against the global `h`. There are no element globals. Get the elements from the surface you are drawing on: `const { Box, Text, Button } = $.ui.resolve(e)`. `e.surface` is `terminal`, `desktop`, `vscode` or `mobile`, and each surface has a different element table, so don't assume one.
- Store values that drawings read in `$.state`. It is session-scoped and survives a hot reload. Declare each value in `types/index.d.ts` under `interface PluginState { '<mod-name>': { ... } }`, and name that file in `plugin.json` as `"types"`. For values that must last across sessions, use `$.store`. Module-level variables reset on every reload.
- Never write state from inside a `ui.render` hook. Write it from a press handler or from another event, using `update($, ref, fn)` from `'claude-code'`.
- A guard is a hook whose answer can refuse something (`tool.call`, `prompt.submit`, `command.run` and similar). Give every guard a `.catch(($, e, next) => next.called ? next(e) : { deny: '<why>' })`. Without it, a guard that crashes lets the action through.
- Work that outlives a single event starts in `session.start` and runs on `$.clock.every` / `$.clock.after`.

Common requests and the API that handles each:

| Request | Use |
| --- | --- |
| pane / sidebar / live view | `$.ui.open({ id, title })` + `ui.render` hook on `{ component: 'Pane', requestId: id }` |
| band above the prompt | `ui.render` hook on `{ component: 'AbovePrompt' }` |
| status line text | `$.ui.status(text)`; `undefined` clears it |
| toast | `$.ui.toast(text)` |
| block or rewrite a tool call | `on('tool.call', { tool: 'Bash' }, ...)`: return `{ deny }` or `next({ ...e, ... })` |
| change a submitted prompt | `on('prompt.submit', ...)` → `next({ ...e, text })` |
| add to the system prompt | `on('prompt.compose', ...)`: add a section to what `next(e)` returns |
| slash command | `$.command.register({ name, description })` in `session.start`, then answer from a `command.run` hook with `{ text }` |
| tool the model can call | `$.tool.register(...)` + a `tool.call` hook on `mcp__<mod>__<name>` |

### Types

When Claude Code loads a mod from disk, it writes the declarations into `.claude-plugin/types/`:

- `claude-code/index.d.ts`: the API, about 14,000 lines.
- `claude-code-tools/index.d.ts`: the built-in tools.
- `claude-code-mcp/index.d.ts`: the MCP tools.
- `tsconfig.json`

The API file is too large to read whole. Grep it for the name you need (`'tool.call'`, `Pane: {`, `export type CommandRunInput`) and read that declaration. If the folder doesn't exist yet, load the mod once with `claude --plugin-dir`. Inside Claude Code you can also load the `plugin-authoring` skill, which writes the current build's declarations and gives you their path.

### Develop, check, test

```bash
claude --plugin-dir mods/claude-code/<mod>        # run it from disk; saving a file reloads it
claude plugin validate mods/claude-code/<mod>     # what the engine sees and what it would refuse
claude plugin test mods/claude-code/<mod>         # run the mod's *.test.ts files
tsc -p mods/claude-code/<mod>                     # type-check (needs .claude-plugin/types)
claude --debug --plugin-dir mods/claude-code/<mod>  # skipped hooks and refused trees are logged with reasons
```

- To load mods in a Claude desktop app session, list their absolute folder paths in `CLAUDE_CODE_PLUGIN_DIRS`, in the `env` block of `~/.claude/settings.json`.
- To develop through the installed path instead: run `claude plugin marketplace add "$PWD"` and `/plugin install <mod>@mods-harness-gui`. A marketplace added from a local folder reads mods from that folder, so run `/reload-plugins` after each edit.
- Function hooks need a recent Claude Code; this layout was validated with 2.1.295. If `claude --version` is older, update it, or point `CLAUDE_BIN` at a newer binary for `scripts/mods.py check --run-claude`.
- Write at least one test for the behaviour a mod adds. In tests, `$.command.run` takes the full input: `{ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }`. The template's test shows it.

### Install (users)

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace Adam-Fresko/mods-harness-gui
```

The marketplace entry's `source` is `./mods/claude-code/<mod>`.

## Codex mods (`mods/codex/<mod>/`)

A Codex mod is a Codex plugin. It bundles skills, MCP servers, lifecycle hooks and apps behind one manifest.

```
.codex-plugin/plugin.json          manifest (fields below)
skills/<skill>/SKILL.md            YAML frontmatter `name` + `description`, then the instructions
skills/<skill>/agents/openai.yaml  optional UI metadata: interface.display_name, short_description, default_prompt
skills/<skill>/scripts/ references/ assets/   optional; SKILL.md refers to them by relative path
.mcp.json                          optional: { "mcpServers": { "<name>": { "command", "args", "cwd", "env_vars" } } }
assets/                            icons the manifest's interface points to
README.md
```

### Manifest (`.codex-plugin/plugin.json`)

- Identity: `name`, `version`, `description`, `author` (`{ name, email?, url? }`), `homepage`, `repository`, `license`, `keywords`.
- Components. Each one is optional, and paths are relative to the mod folder:
  - `"skills": "./skills/"`
  - `"mcpServers": "./.mcp.json"`
  - `"apps": "./.app.json"`
  - `"hooks": { "hooks": { "<Event>": [ { "hooks": [ { "type": ..., ... } ] } ] } }`: lifecycle hooks, inline in the manifest. See Hooks below.
- `interface` is how the mod is listed in the Codex app:
  - `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`
  - `capabilities`, e.g. `["Interactive", "Read", "Write"]`
  - `defaultPrompt`: a list of starter prompts
  - `brandColor`, `logo`, `logoDark`, `composerIcon`: paths into `assets/`

### Skills

- A skill's `description` decides when Codex uses it. Say what the skill does and when to use it, in one or two sentences.
- Keep `SKILL.md` focused. Move long material into `references/` and code into `scripts/`, and tell the skill to read or run them.
- The user can call a skill explicitly as `$<skill-name>`.

### Hooks

Hooks go inline in the manifest. Each event maps to a list of groups, and each group holds a list of handlers:

```json
"hooks": {
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "<server from this mod's .mcp.json>",
            "tool": "<tool>",
            "input": { "session_id": "${session_id}", "turn_id": "${turn_id}" }
          }
        ]
      }
    ]
  }
}
```

- Events in codex-cli 0.160.1: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.
- An `mcp_tool` handler calls a tool on one of the mod's own MCP servers. `${hook_event_name}`, `${session_id}`, `${turn_id}` and `${agent_id}` in `input` are filled in when the hook runs. The bundled OpenAI plugins (browser, chrome) use this form.
- Hooks are a stable feature (`codex features list` shows `hooks`).

### Develop, check, install

Commands verified with codex-cli 0.160.1:

```bash
codex plugin marketplace add "$PWD"                 # once per machine: registers this checkout as `mods-harness-gui`
codex plugin add <mod>@mods-harness-gui             # install; re-run after every edit
codex plugin list --marketplace mods-harness-gui    # status of every mod
codex plugin remove <mod>@mods-harness-gui
```

- Codex installs a copy of the mod into `$CODEX_HOME/plugins/cache/mods-harness-gui/<mod>/<version>/`. Your edits reach Codex only when you re-run `codex plugin add`, and then only in a new session.
- `codex plugin marketplace add "$PWD"` registers the folder you run it from. Run it from the checkout you edit; a worktree has its own path.
- To try a mod without touching your real Codex config, point `CODEX_HOME` at an empty temporary folder for those commands: `export CODEX_HOME="$(mktemp -d)"`.
- Codex has no plugin validator. `python3 scripts/mods.py check` and a successful `codex plugin add` are the checks.

### Install (users)

```bash
codex plugin marketplace add Adam-Fresko/mods-harness-gui
codex plugin add <mod>@mods-harness-gui
```

The marketplace entry's `source` is `{ "source": "local", "path": "./mods/codex/<mod>" }`, with a `policy` and a `category`. The script writes it.

## Adding another app

1. Add `mods/<app>/` with a `.gitkeep`.
2. Add `templates/<app>/` with a working starter mod. Use the placeholders `__MOD_NAME__`, `__DESCRIPTION__` and `__DISPLAY_NAME__`; they work in file contents and in paths.
3. Add the app's marketplace file at the path the app reads.
4. Add an entry to `APPS` in `scripts/mods.py`: the manifest path, the marketplace path, the entry shape, and where an entry stores its source.
5. Add a section for the app here and a line to `README.md`.

## Commits

- Keep one mod, or one repo-level change, per commit when you can.
- Start the subject with what it touches: `claude-code/<mod>: ...`, `codex/<mod>: ...` or `repo: ...`.
