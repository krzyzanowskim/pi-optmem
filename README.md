# pi-optmem

[OptMem](https://github.com/VictorTaelin/OptMem) — permanent memory for AI agents — as a Pi extension, **bundled**. Installing this extension is the whole setup: no `curl | sh`, no python3, no PATH edits, no AGENTS.md block to paste. Zero dependencies (Node builtins only).

## Install

```bash
pi install git:github.com/<you>/pi-optmem
# or from a local checkout:
pi install ./pi-optmem
# or try once:
pi -e ./pi-optmem
```

## What you get

- **`memo` tool** — the agent records, searches, and compresses memories without bash:
  - `note "<one line, ≤280 bytes>"` — record a memory
  - `nap` / `nap <lo-hi> "<line>"` — do pending compressions
  - `recall <regex>` — search every memory ever recorded
  - `zoom <lo-hi>` / `forget <lo-hi>` — navigate the summary tree / drop a bad summary
  - `wake` / `config` / `import` — re-read the memory / tune sizes / bulk-load dated memories
- **Auto-wake**: at every session start the extension runs `memo wake` and injects your memory into the system prompt of every run — it survives compaction.
- **Self-init**: on first use the store is created at `~/.optmem/memory` (or `$MEMORY_DIR`).
- **`/optmem`** command: re-read the memory mid-session.

## The port

`memo.ts` is a faithful TypeScript port of upstream OptMem (vendored at commit `f5b6a24a59b4`): same fixed-width records, same `LOG.txt`/`TREE/` layout, same command semantics — one store can be read by both implementations. Divergences, by design:

- **Locking**: the Python original uses `fcntl.flock` on `.lock`; Node has no flock, so this port uses an atomic-mkdir lock (`.lockdir`) with stale breaking. The two do **not** interlock — never run the Python tool *concurrently* with this one on the same store. Sequential use is safe.
- `recall` regexes are JS `RegExp` (`iu` flags), not Python `re`.
- Printed commands say `memo …` instead of the script path.

`memo.ts` also works standalone for debugging: `node memo.ts wake` (Node ≥ 22.6 runs TS directly).

## Notes

- Memory files are managed by `memo` alone; never edit anything under the memory directory.
- Parallel Pi sessions share the one memory. Subagents must not run `memo` (the injected instructions say so).
- `memo config WAKE_LINES=300` grows the session-start memory read (~96 lines ≈ 8k tokens by default).

Upstream OptMem by Victor Taelin ships without an explicit license; ported here with attribution.
