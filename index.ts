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
 * - Runs `memo wake` at session start and puts the memory in the system
 *   prompt of every run, as its own prompt section (survives compaction).
 * - Registers a `memo` tool so the agent records/searches/compresses
 *   memories without going through bash, drawn as one line per call.
 * - In the TUI, between runs: distills each settled exchange into at most
 *   one memory (auto-note) and does pending compressions (auto-compress),
 *   with a nested model call, showing what it saved in the status line.
 *   Elsewhere a pending compression is handed to the agent once, as a message.
 * - Adds /optmem: status and re-read, recall, config, and the switches for
 *   auto-note, auto-compress and the model they use.
 *
 * Upstream: https://github.com/VictorTaelin/OptMem
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { memoryDir, pretty, recent, runMemo, stats } from "./memo.ts";

const MEMORY_DIR = memoryDir();
const MEMORY_DIR_DISPLAY = pretty(MEMORY_DIR);

/** Compressions one idle stretch may do; the rest wait for the next one. */
const NAPS_PER_IDLE = 32;

/** The memory as injected: the text, and whether wake refused to produce it. */
interface Wake {
	text: string;
	refused: boolean;
	/** ENTRY_CHARS: the byte limit of one memory line. */
	limit: number;
}

/** Transport lines of a multi-part wake; the injected memory needs none. */
const WAKE_CHROME = /^(Your memory, part \d+ of \d+, .*|Not awake yet\. Run: .*)$/;

/** `memo wake`, following the part chain until "You are awake.". A refused
 * wake ("Cannot wake…", exit 1) is kept — its compression prompt is
 * actionable — but a real store error throws so callers can disable
 * injection instead of putting error text into every prompt. The compression
 * a finished wake appends is cut off: it is handed over separately. */
function wakeAll(): Wake {
	const parts: string[] = [];
	let res = runMemo(["wake"]);
	for (let i = 0; ; i++) {
		if (res.code !== 0) {
			if (!res.output.startsWith("Cannot wake")) throw new Error(res.output);
			return { text: [...parts, res.output].join("\n"), refused: true, limit: recent(0).entryChars };
		}
		parts.push(res.output);
		const more = res.output.match(/Not awake yet\. Run: \S+ wake (\d+) (\d+)/);
		if (!more || i >= 20) break;
		res = runMemo(["wake", more[1], more[2]]);
	}
	// Memory lines start with "#", so a bare "You are awake." line is the end.
	const lines = parts.join("\n").split("\n");
	const end = lines.indexOf("You are awake.");
	return {
		text: (end >= 0 ? lines.slice(0, end) : lines)
			.filter((l) => !WAKE_CHROME.test(l))
			.join("\n")
			.trimEnd(),
		refused: false,
		limit: recent(0).entryChars,
	};
}

function memoryBlock(wake: Wake): string {
	return `## Memory

Your memory is OptMem — permanent memory that outlives every session, compaction, model and vendor change. Without it you do not know who you are, or what was decided and tried. Memories live in ${MEMORY_DIR_DISPLAY}.

Use the \`memo\` tool for everything below — never bash, and never edit or delete anything under the memory directory. When memo output says \`Run: memo <command> <args>\`, translate it into a memo tool call: \`memo nap 0-15 "summary"\` means memo({ command: "nap", args: ["0-15", "summary"] }).

### Register memories (mandatory)

Call memo with command "note" whenever you learn something new, or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), any event of lasting effect. One line, at most ${wake.limit} bytes. Do not register redundant memories.

If a memo result or an OptMem message asks for a compression, do it before your next action.

### When you need an old memory: search, or navigate

- memo command "recall" searches every memory ever recorded, word for word.
- Memories form a binary tree of one-line summaries — every \`#a-b\` line below is one node. memo command "zoom" opens a node into its two halves, down to the raw memories.

### Subagents

Parallel sessions on this machine are all you, and may all write memories. A subagent is not: it must never run memo, because it cannot judge what is already known. When you spawn one, write: \`You are a subagent. Don't run memo.\`

### Your memory, read at session start

Memories recorded during this session are not repeated here; recall finds them.

${wake.text}`;
}

/** A path the agent typed: ~ is home, and relative means the session's cwd. */
function userPath(cwd: string, p: string): string {
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return resolve(cwd, p);
}

function clip(s: string, n: number): string {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** A line cut to at most `limit` UTF-8 bytes, never mid-character. */
function fitBytes(line: string, limit: number): string {
	const raw = Buffer.from(line, "utf8");
	if (raw.length <= limit) return line;
	// a sliced multibyte char decodes to U+FFFD
	return raw.subarray(0, limit).toString("utf8").replace(/�+$/g, "").trimEnd();
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The text blocks of a message, thinking and tool calls left out. */
function textOf(m: any): string {
	const c = m?.content;
	if (typeof c === "string") return c;
	return Array.isArray(c)
		? c.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join(" ")
		: "";
}

/** A "provider/model-id" spec, looked up; undefined when there is no such model. */
function findModel(registry: ExtensionContext["modelRegistry"], spec: string): ExtensionContext["model"] {
	const slash = spec.indexOf("/");
	return slash > 0 ? registry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
}

/** One line for a memo result in the transcript; expanding shows it all. */
function summarize(command: string, output: string, failed: boolean): string {
	const first = output.split("\n")[0];
	if (failed) return first;
	const due = output.match(/^Compress memories #(\d+-\d+)/m);
	switch (command) {
		case "note": {
			const m = output.match(/^Saved as #(\d+)\./);
			return m ? `noted #${m[1]}${due ? " · compression due" : ""}` : first;
		}
		case "nap": {
			const saved = output.match(/^(\d+-\d+) saved\./m);
			if (saved) return `compressed ${saved[1]}${due ? ` · next #${due[1]}` : " · nothing left"}`;
			return due && first.startsWith("Compress") ? `compression due: #${due[1]}` : first;
		}
		case "recall":
			return output.split("\n").pop() ?? first;
		case "wake": {
			if (output.startsWith("Cannot wake")) return `cannot wake yet: compression #${due?.[1] ?? "?"} needed`;
			const n = output.split("\n").filter((l) => l.startsWith("#")).length;
			return `${n} memory lines${/Not awake yet/.test(output) ? " · more parts" : ""}`;
		}
		case "zoom":
			return output.split("\n").map((l) => clip(l, 60)).join("  ");
		default:
			return first;
	}
}

export default function (pi: ExtensionAPI) {
	let wake: Wake | null = null;
	/** A pending compression should be offered to the agent with the next run. */
	let offerNap = false;

	// Session switches: the environment sets the defaults, /optmem flips them.
	let autoNote = process.env.PI_OPTMEM_AUTONOTE !== "0";
	let autoNap = process.env.PI_OPTMEM_AUTONAP !== "0";
	/** "provider/model-id" for the nested calls; empty means the session model. */
	let helperSpec = process.env.PI_OPTMEM_MODEL?.trim() ?? "";
	let helperWarned = false;
	/** For /optmem completions, which get no context. */
	let registry: ExtensionContext["modelRegistry"] | null = null;
	/** What auto-note saved this session: the log is append-only, so show it. */
	const autoNoted: string[] = [];

	/** Auto-note and auto-compress run between runs, in the TUI only: print and
	 * RPC sessions end or move on before a background call could land. */
	const background = (ctx: ExtensionContext) => ctx.mode === "tui";
	/** Auto-compress could not get a line from the model: until it can, the
	 * agent does the compressions again, so they never silently pile up. */
	let napStalled = false;
	/** Auto-compress is on here; whether it is currently working is napsInBackground. */
	const compressor = (ctx: ExtensionContext) => autoNap && background(ctx);
	const napsInBackground = (ctx: ExtensionContext) => compressor(ctx) && !napStalled;
	/** Aborts in-flight nested calls when this runtime is torn down. */
	const shutdown = new AbortController();

	function status(ctx: ExtensionContext, text: string): void {
		if (ctx.mode === "tui") ctx.ui.setStatus("optmem", ctx.ui.theme.fg("dim", `optmem: ${text}`));
	}

	function countsLine(): string {
		const s = stats();
		return `${plural(s.memories, "memory", "memories")}${s.pending ? `, ${plural(s.pending, "compression")} pending` : ""}`;
	}

	function refreshWake(): void {
		// First run ever: create the store. `memo init` never touches existing
		// memories, it only creates what is missing.
		if (!existsSync(MEMORY_DIR)) {
			runMemo(["init"]);
		}
		wake = wakeAll();
		offerNap = true;
	}

	/** A refused snapshot is wrong, not just old: re-read it once compressions
	 * let wake through. Returns true when it did. */
	function settleRefusal(): boolean {
		if (!wake?.refused) return false;
		try {
			const w = wakeAll();
			if (w.refused) return false;
			wake = w;
			return true;
		} catch {
			return false; // keep the previous snapshot
		}
	}

	/** The injected memory is a snapshot, re-read at session start, /optmem
	 * and compaction only. Every change to it costs a full prompt section
	 * (~8k tokens) in the transcript, and notes taken now are already in the
	 * transcript. A tool write re-reads it only when the snapshot is wrong:
	 * new sizes or imported memories, or a refused wake that a compression
	 * may have unblocked. */
	function afterTool(command: string, args: string[], code: number): void {
		if (code !== 0) return;
		if (command === "nap" || command === "forget") {
			settleRefusal();
			return;
		}
		// `config` alone only shows the sizes.
		if (command !== "import" && !(command === "config" && args.length)) return;
		try {
			wake = wakeAll();
		} catch {
			/* keep the previous snapshot */
		}
	}

	function helperModel(ctx: ExtensionContext): ExtensionContext["model"] {
		if (helperSpec) {
			const m = findModel(ctx.modelRegistry, helperSpec);
			if (m && ctx.modelRegistry.hasConfiguredAuth(m)) return m;
			if (!helperWarned) {
				helperWarned = true;
				if (ctx.hasUI) ctx.ui.notify(`OptMem: model ${helperSpec} is unavailable; using the session model.`, "warning");
			}
		}
		return ctx.model;
	}

	/** One nested model call that answers with one line, or null. */
	async function ask(ctx: ExtensionContext, systemPrompt: string, content: string): Promise<string | null> {
		const model = helperModel(ctx);
		if (!model) return null;
		// No `reasoning` option turns thinking off where the API allows it; where
		// it does not (OpenAI reasoning models), thinking spends the same budget.
		const maxTokens = model.reasoning ? 4096 : 200;
		const msg = await ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] },
				{ maxTokens, maxRetries: 1, signal: shutdown.signal },
			)
			.result();
		if (msg.stopReason === "error" || msg.stopReason === "aborted") return null;
		const line = textOf(msg)
			.trim()
			.split("\n")[0]
			.trim()
			// models echo the shape of the memories they were shown
			.replace(/^(?:[-*•]\s+|#\d+(?:-\d+)?\s+(?:\d{4}-\d{2}-\d{2}\s+)?)/, "")
			.replace(/^['"]|['". ]+$/g, "");
		return line || null;
	}

	const memoTool = defineTool({
		name: "memo",
		label: "OptMem",
		description: `OptMem permanent memory (store: ${MEMORY_DIR_DISPLAY}). The session-start memory snapshot is already in your system prompt — do not re-wake unless a memo result or the user asks you to.

Commands, with CLI arguments split into the args array (no shell quoting; a note/summary text is ONE array element):
- wake [part] [T] — re-read the memory.
- note "<one line>" — record one memory, within the byte limit in your Memory instructions. If the result asks for a compression, do it before anything else: read the block it prints, then nap with your one-line summary.
- nap — show the next pending compression. nap <lo-hi> "<one-line summary>" — submit one (e.g. args ["0-15", "…"]).
- recall <regex> — search every memory ever recorded, word for word (JavaScript regex, case-insensitive).
- zoom <lo-hi> — open a tree node into its two halves (e.g. "0-15"), down to raw memories.
- forget <lo-hi> — drop a bad summary; the next nap rebuilds it.
- config [NAME=VALUE …] — show or change sizes (e.g. WAKE_LINES=300).
- import <file> — bulk-load lines of "YYYY-MM-DD <text>" (bootstrap only; the path is relative to the working directory).`,
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = [...(params.args ?? [])];
			if (params.command === "import" && args.length === 1) args[0] = userPath(ctx.cwd, args[0]);
			const res = runMemo([params.command, ...args]);
			afterTool(params.command, args, res.code);
			let text = res.output;
			// Auto-compress pays the compression a note makes due, after the run;
			// the agent goes on with its work instead.
			if (params.command === "note" && res.code === 0 && napsInBackground(ctx)) {
				text = text.split("\n\n")[0];
			}
			// "Cannot wake" (exit 1) is not a failure: it carries the compression
			// the model must do next. Everything else non-zero is a usage error.
			const failed = res.code !== 0 && !res.output.startsWith("Cannot wake");
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: { command: params.command, exitCode: res.code, summary: summarize(params.command, text, failed) },
				...(failed ? { isError: true } : {}),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("memo ")) + theme.fg("muted", args.command ?? "");
			const rest = (args.args ?? []).join(" ");
			if (rest) text += ` ${theme.fg("dim", clip(rest, 80))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
			const out = result.content[0]?.type === "text" ? result.content[0].text : "";
			const d = result.details as { command: string; exitCode: number; summary?: string } | undefined;
			const failed = !!d && d.exitCode !== 0 && !out.startsWith("Cannot wake");
			if (expanded) return new Text(failed ? theme.fg("error", out) : out, 0, 0);
			const line = d?.summary ?? summarize(d?.command ?? "", out, failed);
			return new Text(theme.fg(failed ? "error" : "muted", clip(line, 120)), 0, 0);
		},
	});

	// ---- between runs: auto-note and auto-compress ----
	// Best effort, TUI only, one nested model call per memory or compression.
	// Auto-note is a safety net for sessions where the agent never ran memo
	// note: the model answers with one memory line or NOTHING. Auto-compress
	// does the compressions notes make due, so they never interrupt a run.
	let noteMarker: string | null = null; // last session entry already distilled
	let busy = false;

	function markBranch(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		noteMarker = branch.length ? branch[branch.length - 1].id : null;
	}

	/** New transcript tail since the marker, as "role: text" lines. */
	function collectNew(ctx: ExtensionContext): { id: string | null; text: string; hasUser: boolean } {
		const branch = ctx.sessionManager.getBranch();
		const lines: string[] = [];
		let lastId = noteMarker;
		let started = noteMarker === null;
		let hasUser = false;
		for (const e of branch) {
			if (!started) {
				if (e.id === noteMarker) started = true;
				continue;
			}
			lastId = e.id;
			if (e.type !== "message") continue;
			const m = (e as any).message;
			const role = m?.role;
			if (role !== "user" && role !== "assistant") continue;
			let t = textOf(m).trim();
			if (!t) continue;
			if (role === "user") hasUser = true;
			if (t.length > 400) t = t.slice(0, 400) + "…";
			lines.push(`${role}: ${t}`);
		}
		if (!started) {
			// The marker left the branch (/tree, fork): restart from its end
			// rather than stalling forever.
			markBranch(ctx);
			return { id: null, text: "", hasUser: false };
		}
		let text = lines.join("\n");
		if (text.length > 6000) text = text.slice(-6000);
		return { id: lastId, text, hasUser };
	}

	async function distill(ctx: ExtensionContext, conversation: string): Promise<void> {
		// The log, not the snapshot: it holds this session's notes too.
		const known = recent(12);
		const line = await ask(
			ctx,
			`You maintain a permanent one-line-per-memory store for the agent you serve. Extract at most ONE line of lasting value from the conversation, at most ${known.entryChars} bytes: a decision, a fact the user taught, a preference, a completed task worth remembering. Never duplicate what is already known. If nothing qualifies, reply exactly: NOTHING`,
			`Already known (newest memories):\n${known.lines.join("\n") || "(none)"}\n\nConversation:\n${conversation}\n\nReply with the one memory line, or NOTHING.`,
		);
		if (!line || /^NOTHING\b/i.test(line)) return;
		const text = fitBytes(line, known.entryChars);
		const res = runMemo(["note", text]);
		if (res.code !== 0) return;
		const id = res.output.match(/^Saved as #(\d+)\./)?.[1] ?? "?";
		autoNoted.push(`#${id} ${text}`);
		status(ctx, `noted #${id} "${clip(text, 60)}"`);
		// A note can make a compression due; without auto-compress the agent
		// gets it with the next run.
		offerNap = true;
	}

	/** Do pending compressions while the session is idle. */
	async function compress(ctx: ExtensionContext): Promise<void> {
		let done = 0;
		for (let i = 0; i < NAPS_PER_IDLE && ctx.isIdle() && !shutdown.signal.aborted; i++) {
			const res = runMemo(["nap"]);
			const m = res.code === 0 ? res.output.match(/^Compress memories #(\d+-\d+) into one line of at most (\d+) bytes\./) : null;
			if (!m) break;
			// The prompt as memo prints it, minus the CLI instructions.
			const task = res.output
				.split("\n")
				.filter((l) => !/^Run: |remains? after this one\.$/.test(l))
				.join("\n")
				.trim();
			let line: string | null = null;
			try {
				line = await ask(
					ctx,
					"You compress memories for a permanent memory store. Reply with only the one compressed line: no preamble, no quotes.",
					task,
				);
			} catch {
				/* treated as no answer */
			}
			if (shutdown.signal.aborted) return;
			if (!line) {
				// Hand compressions back to the agent rather than let them pile up.
				napStalled = true;
				offerNap = true;
				status(ctx, "compression failed; the agent will do it");
				return;
			}
			const out = runMemo(["nap", m[1], fitBytes(line, +m[2])]);
			if (out.code !== 0) break;
			done++;
		}
		if (!done) return;
		const ready = settleRefusal() ? " · memory ready" : "";
		const left = stats().pending;
		status(ctx, `compressed ${plural(done, "block")}${left ? `, ${left} pending` : ""}${ready}`);
	}

	/** One background job at a time; a settle that finds it busy leaves its
	 * transcript tail for the next one. */
	function work(ctx: ExtensionContext, conversation: string | null): void {
		busy = true;
		void (async () => {
			try {
				if (conversation) await distill(ctx, conversation);
				if (compressor(ctx)) {
					napStalled = false; // try the model again
					await compress(ctx);
				}
			} catch {
				/* best-effort: never disturb the session */
			} finally {
				busy = false;
			}
		})();
	}

	pi.registerTool(memoTool);

	// ---- /optmem ----
	const SUBCOMMANDS: [string, string][] = [
		["recall", "<regex> — search every memory"],
		["config", "[NAME=VALUE …] — show or change sizes"],
		["autonote", "on|off — distill each exchange into a memory"],
		["autonap", "on|off — do compressions between runs"],
		["model", "<provider/id>|default — the model auto-note and auto-compress use"],
	];

	function onOff(arg: string, current: boolean): boolean | null {
		if (arg === "on") return true;
		if (arg === "off") return false;
		return arg === "" ? !current : null;
	}

	async function show(ctx: ExtensionContext, title: string, output: string, type: "info" | "error" = "info"): Promise<void> {
		if (!ctx.hasUI) return;
		const lines = output.split("\n");
		// Long output gets a scrollable list instead of a wall of notification.
		if (lines.length > 12 && type === "info") await ctx.ui.select(title, lines);
		else ctx.ui.notify(`${title}\n${output}`, type);
	}

	pi.registerCommand("optmem", {
		description: "OptMem: status and re-read; recall, config, autonote, autonap, model",
		getArgumentCompletions(prefix) {
			const sp = prefix.indexOf(" ");
			if (sp < 0) {
				const items = SUBCOMMANDS.filter(([n]) => n.startsWith(prefix)).map(([n, d]) => ({ value: `${n} `, label: n, description: d }));
				return items.length ? items : null;
			}
			const sub = prefix.slice(0, sp);
			const rest = prefix.slice(sp + 1);
			let options: string[] = [];
			if (sub === "autonote" || sub === "autonap") options = ["on", "off"];
			else if (sub === "config") options = ["WAKE_LINES=", "ENTRY_CHARS=", "PART_CHARS=", "PART_LINES="];
			else if (sub === "model" && registry) {
				options = ["default", ...registry.getAvailable().map((m) => `${m.provider}/${m.id}`)];
			}
			// config takes several NAME=VALUE words: complete the last one.
			const cut = sub === "config" ? rest.lastIndexOf(" ") + 1 : 0;
			const word = rest.slice(cut);
			const head = `${sub} ${rest.slice(0, cut)}`;
			const items = options.filter((o) => o.startsWith(word)).map((o) => ({ value: `${head}${o}`, label: o }));
			return items.length ? items : null;
		},
		handler: async (raw, ctx) => {
			const input = raw.trim();
			const sp = input.indexOf(" ");
			const sub = sp < 0 ? input : input.slice(0, sp);
			const arg = sp < 0 ? "" : input.slice(sp + 1).trim();
			try {
				switch (sub) {
					case "": {
						refreshWake();
						const model = helperSpec || "the session model";
						const lines = [
							`${MEMORY_DIR_DISPLAY}: ${countsLine()}`,
							`auto-note ${autoNote ? "on" : "off"} · auto-compress ${autoNap ? (napStalled ? "stalled (the agent does it)" : "on") : "off"} · model: ${model}`,
							...(autoNoted.length ? ["Auto-noted this session:", ...autoNoted.map((l) => `  ${clip(l, 100)}`)] : []),
							"Memory re-read; active from the next message.",
						];
						ctx.ui.notify(`OptMem\n${lines.join("\n")}`, "info");
						return;
					}
					case "recall": {
						if (!arg) return ctx.ui.notify("Usage: /optmem recall <regex>", "error");
						const res = runMemo(["recall", arg]);
						return show(ctx, `OptMem recall /${arg}/`, res.output, res.code ? "error" : "info");
					}
					case "config": {
						const knobs = arg.split(/\s+/).filter(Boolean);
						const res = runMemo(["config", ...knobs]);
						afterTool("config", knobs, res.code);
						return show(ctx, "OptMem sizes", res.output, res.code ? "error" : "info");
					}
					case "autonote":
					case "autonap": {
						const v = onOff(arg, sub === "autonote" ? autoNote : autoNap);
						if (v === null) return ctx.ui.notify(`Usage: /optmem ${sub} on|off`, "error");
						if (sub === "autonote") autoNote = v;
						else {
							autoNap = v;
							napStalled = false;
							offerNap = true; // off: the agent takes over what is pending
						}
						ctx.ui.notify(`OptMem: ${sub === "autonote" ? "auto-note" : "auto-compress"} ${v ? "on" : "off"} for this session.`, "info");
						if (sub === "autonap" && v && !busy && compressor(ctx)) work(ctx, null);
						return;
					}
					case "model": {
						if (!arg || arg === "default") {
							helperSpec = "";
							napStalled = false;
							return ctx.ui.notify("OptMem: auto-note and auto-compress use the session model.", "info");
						}
						const m = findModel(ctx.modelRegistry, arg);
						if (!m) return ctx.ui.notify(`OptMem: no model ${arg}. Use provider/model-id.`, "error");
						if (!ctx.modelRegistry.hasConfiguredAuth(m)) return ctx.ui.notify(`OptMem: ${arg} has no credentials configured.`, "error");
						helperSpec = arg;
						helperWarned = false;
						napStalled = false;
						return ctx.ui.notify(`OptMem: auto-note and auto-compress use ${arg} for this session.`, "info");
					}
					default:
						return ctx.ui.notify(
							`Usage: /optmem [${SUBCOMMANDS.map(([n]) => n).join("|")}]\n${SUBCOMMANDS.map(([n, d]) => `  ${n} ${d}`).join("\n")}`,
							"error",
						);
				}
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`OptMem: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		registry = ctx.modelRegistry;
		try {
			const fresh = !existsSync(MEMORY_DIR);
			refreshWake();
			if (fresh && ctx.hasUI) {
				ctx.ui.notify(`OptMem: created a new memory at ${MEMORY_DIR_DISPLAY}`, "info");
			}
			status(ctx, countsLine());
			if (compressor(ctx) && stats().pending) work(ctx, null);
		} catch (err) {
			wake = null;
			if (ctx.hasUI) ctx.ui.notify(`OptMem disabled: ${(err as Error).message}`, "error");
		}
		// Resume: never re-distill history that predates this session.
		markBranch(ctx);
	});

	// Compaction already invalidated the cached prompt, and summarized away the
	// notes taken this session: the moment to bring the snapshot up to date.
	pi.on("session_compact", async () => {
		if (!wake) return;
		try {
			refreshWake();
		} catch {
			/* keep the previous snapshot */
		}
	});

	pi.on("session_shutdown", async () => {
		shutdown.abort();
	});

	// Moving in the session tree: what is "new" restarts from the new leaf.
	pi.on("session_tree", async (_event, ctx) => {
		markBranch(ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!background(ctx) || busy || !wake) return;
		let conversation: string | null = null;
		// An aborted run may be half an exchange; its tail is taken next time.
		if (autoNote && !event.aborted) {
			const { id, text, hasUser } = collectNew(ctx);
			if (id && hasUser && text.length >= 80) {
				noteMarker = id; // dispatched; a failed distill loses this tail (best-effort)
				conversation = text;
			}
		}
		if (conversation || compressor(ctx)) work(ctx, conversation);
	});

	// Inject the memory into every run's system prompt, so it survives
	// compaction instead of living in (compressible) transcript messages. A
	// named section lets pi send a change as a delta and keep the cached
	// prefix; returning `systemPrompt` would force the whole prompt instead,
	// which is the fallback for a pi without prompt sections.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!wake) return undefined;
		const block = memoryBlock(wake);
		let message: { customType: string; content: string; display: boolean } | undefined;
		if (offerNap && !wake.refused && !napsInBackground(ctx)) {
			offerNap = false;
			const res = runMemo(["nap"]);
			if (res.code === 0 && !res.output.startsWith("Nothing left")) {
				message = { customType: "optmem", content: `OptMem: a compression is due.\n\n${res.output}`, display: false };
			}
		}
		const sections = event.systemPromptOptions?.sections;
		if (sections) {
			sections.optmem = block;
			return message ? { message } : undefined;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${block}`, ...(message ? { message } : {}) };
	});
}
