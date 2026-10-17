# pi-optmem

[OptMem](https://github.com/VictorTaelin/OptMem) as a Pi extension. OptMem is Victor Taelin's permanent memory for AI agents; this package ships a TypeScript port, so installing the extension is the only setup. No python3, no `curl | sh`. Node builtins only.

## Install

```bash
pi install git:github.com/krzyzanowskim/pi-optmem   # or a local checkout: pi install ./pi-optmem
pi -e ./pi-optmem                           # try once without installing
```

## What it does

At session start it runs `memo wake` and puts your memory into the system prompt of every run, so it survives compaction. The snapshot stays fixed for the session (so the prompt cache holds) and is re-read after compaction or with `/optmem`; notes taken mid-session are in the transcript meanwhile. It registers a `memo` tool the agent uses instead of bash: `wake`, `note`, `nap`, `recall`, `zoom`, `forget`, `config`, `import`. Each call is drawn as one line (`noted #41`, `compressed 0-15`); expand it for the full output.

In the interactive TUI, the extension also works between runs, with a nested model call:

- **Auto-note**: after each settled exchange it may save one more memory line. The log is append-only, so each one shows in the status line (`optmem: noted #412 "…"`) and in `/optmem`.
- **Auto-compress**: it does the compressions that notes make due, up to 32 per idle stretch, pausing when you start a run. The agent is no longer interrupted for them, unless the model call fails; then the agent does them until the next attempt succeeds. In print and RPC modes the agent does them, as upstream intends.

## Settings

| Environment | `/optmem` | Default |
|---|---|---|
| `PI_OPTMEM_AUTONOTE=0` | `autonote on\|off` | on |
| `PI_OPTMEM_AUTONAP=0` | `autonap on\|off` | on |
| `PI_OPTMEM_MODEL=provider/model-id` | `model provider/model-id\|default` | the session model |

Environment variables set the defaults; `/optmem` switches last for the session. A small, cheap model is enough for both jobs.

`/optmem` alone shows the store, its size, the switches and this session's auto-notes, and re-reads the memory. `/optmem recall <regex>` searches it. `/optmem config WAKE_LINES=300` grows the session-start read; 96 lines is about 8k tokens, and every line goes into every prompt.

The store is created on first use at `~/.optmem/memory`, or `$MEMORY_DIR` if set.

## The port

`memo.ts` is a TypeScript port of upstream OptMem (commit `f5b6a24a59b4`; `memo` is unchanged through upstream `main` at `1fb164c`) with the same fixed-width record format, so both implementations can read one store. Differences:

- Locking: the Python original uses `fcntl.flock` (`msvcrt` on Windows); Node has no flock, so this port locks with an atomic mkdir. The two locks don't interlock, so don't run the Python tool at the same time as a Pi session on the same store. Sequential use is fine.
- `recall` takes JavaScript regex: no Python-only syntax such as `(?i)` or `(?P<name>…)`. Searches are case-insensitive either way.
- Messages name the tool `memo` rather than the script's path, and `init` prints no AGENTS.md block, because the extension injects the instructions itself.

Standalone: `node memo.ts wake`. That needs Node 22.18+ or 23.6+ to run TypeScript directly (22.6–22.17: add `--experimental-strip-types`).

Don't edit anything under the memory directory; `memo` manages it. Parallel Pi sessions share one memory; subagents must not run `memo` (the injected instructions already say so).

Upstream OptMem ships without a license file; ported with attribution.
