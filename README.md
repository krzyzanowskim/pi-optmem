# pi-optmem

[OptMem](https://github.com/VictorTaelin/OptMem) as a Pi extension. OptMem is Victor Taelin's permanent memory for AI agents; this package ships a TypeScript port, so installing the extension is the only setup. No python3, no `curl | sh`. Node builtins only.

## Install

```bash
pi install git:github.com/krzyzanowskim/pi-optmem   # or a local checkout: pi install ./pi-optmem
pi -e ./pi-optmem                           # try once without installing
```

## What it does

At session start it runs `memo wake` and puts your memory into the system prompt of every run, so it survives compaction. It registers a `memo` tool the agent uses instead of bash: `note`, `nap`, `recall`, `zoom`, `forget`, `config`, `import`. After each settled exchange it can distill one more memory line (disable with `PI_OPTMEM_AUTONOTE=0`). `/optmem` re-reads the memory mid-session.

The store is created on first use at `~/.optmem/memory`, or `$MEMORY_DIR` if set. `memo config WAKE_LINES=300` grows the session-start read; 96 lines is about 8k tokens.

## The port

`memo.ts` is a TypeScript port of upstream OptMem (commit `f5b6a24a59b4`) with the same fixed-width record format, so both implementations can read one store. Two differences:

- Locking: the Python original uses `fcntl.flock`; Node has no flock, so this port locks with an atomic mkdir. The two locks don't interlock, so don't run the Python tool at the same time as a Pi session on the same store. Sequential use is fine.
- `recall` takes JavaScript regex.

Standalone: `node memo.ts wake` (Node 22.6+ runs TypeScript directly).

Don't edit anything under the memory directory; `memo` manages it. Parallel Pi sessions share one memory; subagents must not run `memo` (the injected instructions already say so).

Upstream OptMem ships without a license file; ported with attribution.
