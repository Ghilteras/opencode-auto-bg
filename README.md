# opencode-auto-bg

Transparent automatic backgrounding for OpenCode subagents. Zero API changes — you keep calling `task()` as usual, this plugin backgrounds your architect's children automatically.

## What it does

Two features on the `event` hook:

1. **Auto-background** (`session.created`) — when architect spawns a child subagent, this plugin polls until the child is busy, then calls `POST /experimental/session/<parentID>/background`. The parent goes idle immediately and the turn returns to the user. No more "delegating task..." hanging.

2. **Wake safety net** (`session.idle`) — in ~3% of cases the native OpenCode wake fails to deliver the `<task_result>` back to the parent. This watchdog detects the gap and re-injects the wake with the parent's previous model to preserve prompt cache.

## Install

```bash
npm install opencode-auto-bg
```

## Configure

Add to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["opencode-auto-bg"]
}
```

The plugin auto-detects sessions whose parent agent is `"architect"`. To target a different primary agent, set in `opencode.jsonc`:

```json
{
  "agent": {
    "config": {
      "opencode-auto-bg": {
        "parentAgent": "build"
      }
    }
  }
}
```

## Requirements

- OpenCode with plugin support
- No npm dependencies (uses built-in `fetch()`)

## How it works

- `session.created` → polls child status every 200ms up to 10s. When the child becomes "busy", backgrounds the parent.
- `session.idle` on a child → watches the parent for 5 minutes. If the parent stays idle without processing the task result, sends a wake message reusing the parent's last model to preserve prompt cache.

## Why?

OpenCode's native subagent delegation keeps the parent in foreground until the child completes. The built-in background API exists but has to be called manually. This plugin makes it automatic and handles edge cases the native wake misses.

## License

MIT
