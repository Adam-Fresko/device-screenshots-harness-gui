# mods-harness-gui

Mods for AI coding harnesses: [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex). Each app gets its own folder of mods and its own marketplace file, so both install straight from this repo.

## Install a mod

Claude Code, at the prompt of a terminal session:

```
/plugin install <mod> --marketplace Adam-Fresko/mods-harness-gui
```

Codex:

```bash
codex plugin marketplace add Adam-Fresko/mods-harness-gui
```

```bash
codex plugin add <mod>@mods-harness-gui
```

## Mods

| App | Mod | What it does |
| --- | --- | --- |
| | | No mods yet. |

## Layout

```
.claude-plugin/marketplace.json   Claude Code marketplace (lists mods/claude-code/*)
.agents/plugins/marketplace.json  Codex marketplace (lists mods/codex/*)
mods/claude-code/<mod>/           one Claude Code plugin per folder
mods/codex/<mod>/                 one Codex plugin per folder
templates/<app>/                  starter files for a new mod
scripts/mods.py                   scaffold and check mods
```

## Make a mod

```bash
python3 scripts/mods.py new claude-code my-mod -d "One line about what it does."
```

```bash
python3 scripts/mods.py check
```

[AGENTS.md](AGENTS.md) has the full rules and the develop, test and install loop for each app.
