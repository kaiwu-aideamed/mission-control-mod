# mission-control

Claude Code mod: a status band above the prompt showing the current task, stage, model routing
(model / who chose it / why / what actually ran), Codex workers, workflows and decision cards.

## Install

```sh
git clone https://github.com/kaiwu-aideamed/mission-control-mod.git ~/.claude/mods/mission-control
```

Add to `~/.claude/settings.json`, then restart Claude Code:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/.claude/mods/mission-control" }
```

Codex workers need the `codex` CLI; dispatch them with `bin/dispatch-codex`.

## Use

- `/flow` toggles the expanded card (on by default).
- The model calls the `mission` tool to set task / stage / route; subagent and Codex dispatches fill the route automatically.

## Develop

```sh
claude plugin validate .
claude plugin test .
```
