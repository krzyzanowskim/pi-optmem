/**
 * pi-optmem — OptMem permanent memory for Pi, bundled.
 *
 * Installing this extension is the whole setup: OptMem ships inside this
 * package (./memo.ts, a dependency-free TypeScript port that is
 * byte-compatible with the Python original) and the memory store
 * self-initializes on first session. No python3, no curl, no PATH edits,
 * no AGENTS.md block to paste.
 *
 * What it does:
 * - Runs `memo wake` at session start and injects the memory into the
 *   system prompt of every run (survives compaction).
 * - Registers a `memo` tool so the agent records/searches/compresses
 *   memories without going through bash.
 * - Adds /optmem to re-read the memory mid-session.
 *
 * Upstream: https://github.com/VictorTaelin/OptMem
 */

import { existsSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryDir, pretty, runMemo } from "./memo.ts";

const MEMORY_DIR = memoryDir();
const MEMORY_DIR_DISPLAY = pretty(MEMORY_DIR);

/** Set by the factory; lets the tool trigger a wake refresh after writes. */
let onMutated: ((command: string, code: number) => void) | null = null;

/** `memo wake`, following the part chain until "You are awake.". A refused
 * wake ("Cannot wake…", exit 1) is kept — its compression prompt is
 * actionable — but a real store error throws so callers can disable
 * injection instead of putting error text into every prompt. */
function wakeAll(): string {
	const parts: string[] = [];
	let res = runMemo(["wake"]);
	if (res.code !== 0 && !res.output.startsWith("Cannot wake")) throw new Error(res.output);
	parts.push(res.output);
	for (let i = 0; i < 20; i++) {
		const more = res.code === 0 && res.output.match(/Not awake yet\. Run: \S+ wake (\d+) (\d+)/);
		if (!more) break;
		res = runMemo(["wake", more[1], more[2]]);
		if (res.code !== 0 && !res.output.startsWith("Cannot wake")) throw new Error(res.output);
		parts.push(res.output);
	}
	return parts.join("\n");
}

function memoryBlock(wake: string): string {
	return `

## Memory

Your memory is OptMem — permanent memory that outlives every session, compaction, model and vendor change. Without it you do not know who you are, or what was decided and tried. Memories live in ${MEMORY_DIR_DISPLAY}.

Use the \`memo\` tool for everything below — never bash, and never edit or delete anything under the memory directory. When memo output says \`Run: memo <command> <args>\`, translate it into a memo tool call: \`memo nap 0-15 "summary"\` means memo({ command: "nap", args: ["0-15", "summary"] }).

### Register memories (mandatory)

Call memo with command "note" whenever you learn something new, or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), any event of lasting effect. One line, at most 280 bytes. Do not register redundant memories.

If a memo result asks for a compression, do it before your next action.

### When you need an old memory: search, or navigate

- memo command "recall" searches every memory ever recorded, word for word.
- Memories form a binary tree of one-line summaries — every \`#a-b\` line below is one node. memo command "zoom" opens a node into its two halves, down to the raw memories.

### Subagents

Parallel sessions on this machine are all you, and may all write memories. A subagent is not: it must never run memo, because it cannot judge what is already known. When you spawn one, write: \`You are a subagent. Don't run memo.\`

### Your memory, read at session start

${wake}`;
}

const memoTool = defineTool({
	name: "memo",
	label: "OptMem",
	description: `OptMem permanent memory (store: ${MEMORY_DIR_DISPLAY}). The session-start memory snapshot is already in your system prompt — do not re-wake unless asked.

Commands, with CLI arguments split into the args array (no shell quoting; a note/summary text is ONE array element):
- wake [part] [T] — re-read the memory.
- note "<one line, at most 280 bytes>" — record one memory. If the result asks for a compression, do it before anything else: read the block it prints, then nap with your one-line summary.
- nap — show the next pending compression. nap <lo-hi> "<one-line summary>" — submit one (e.g. args ["0-15", "…"]).
- recall <regex> — search every memory ever recorded, word for word.
- zoom <lo-hi> — open a tree node into its two halves (e.g. "0-15"), down to raw memories.
- forget <lo-hi> — drop a bad summary; the next nap rebuilds it.
- config [NAME=VALUE …] — show or change sizes (e.g. WAKE_LINES=300).`,
	parameters: Type.Object({
		command: Type.Union(
			[
				Type.Literal("wake"),
				Type.Literal("note"),
				Type.Literal("nap"),
				Type.Literal("recall"),
				Type.Literal("zoom"),
				Type.Literal("forget"),
				Type.Literal("config"),
				Type.Literal("import"),
			],
			{ description: "memo subcommand" },
		),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "Arguments for the subcommand, already split — no shell quoting.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const res = runMemo([params.command, ...(params.args ?? [])]);
		onMutated?.(params.command, res.code);
		// "Cannot wake" (exit 1) is not a failure: it carries the compression
		// the model must do next. Everything else non-zero is a usage error.
		const failed = res.code !== 0 && !res.output.startsWith("Cannot wake");
		return {
			content: [{ type: "text", text: res.output || "(no output)" }],
			details: { command: params.command, exitCode: res.code },
			...(failed ? { isError: true } : {}),
		};
	},
});

export default function (pi: ExtensionAPI) {
	let wakeBlock: string | null = null;

	function refreshWake(): void {
		// First run ever: create the store. `memo init` never touches existing
		// memories, it only creates what is missing.
		if (!existsSync(MEMORY_DIR)) {
			runMemo(["init"]);
		}
		wakeBlock = wakeAll();
	}

	/** Keep the injected snapshot current after writes (notes land in the
	 * transcript, but a settled compression can unblock a refused wake). */
	const MUTATING = new Set(["note", "nap", "forget", "import", "config"]);
	function refreshAfter(command: string, code: number): void {
		if (code === 0 && MUTATING.has(command)) {
			try {
				wakeBlock = wakeAll();
			} catch {
				/* keep the previous snapshot */
			}
		}
	}

	pi.registerTool(memoTool);
	onMutated = refreshAfter;

	pi.registerCommand("optmem", {
		description: "Re-read the OptMem memory (memo wake) for the next prompt",
		handler: async (_args, ctx) => {
			try {
				refreshWake();
				if (ctx.hasUI) ctx.ui.notify("OptMem: memory re-read, active from the next message.", "info");
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`OptMem: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const fresh = !existsSync(MEMORY_DIR);
			refreshWake();
			if (fresh && ctx.hasUI) {
				ctx.ui.notify(`OptMem: created a new memory at ${MEMORY_DIR_DISPLAY}`, "info");
			}
		} catch (err) {
			wakeBlock = null;
			if (ctx.hasUI) ctx.ui.notify(`OptMem disabled: ${(err as Error).message}`, "error");
		}
	});

	// Inject the memory into every run's system prompt, so it survives
	// compaction instead of living in (compressible) transcript messages.
	pi.on("before_agent_start", async (event) => {
		if (!wakeBlock) return undefined;
		return { systemPrompt: event.systemPrompt + memoryBlock(wakeBlock) };
	});
}
