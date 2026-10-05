/**
 * memo.ts — TypeScript port of OptMem (https://github.com/VictorTaelin/OptMem),
 * vendored at upstream commit f5b6a24a59b4. Byte-compatible with the Python
 * original: same fixed-width records, same LOG.txt/TREE layout, same command
 * semantics, so both implementations can share one store.
 *
 * Deliberate divergences from the Python original:
 * - Locking: Python uses fcntl.flock on `.lock`; Node has no flock, so this
 *   port uses an atomic mkdir lock (`.lockdir`) with stale breaking. The two
 *   locks do NOT interlock — never run the Python tool concurrently with
 *   this one on the same store. Sequential use is safe.
 * - Regexes in `recall` are JS RegExp (flag "iu"), not Python re.
 * - Messages name the tool as `memo` instead of the script path.
 * - `init` does not print the AGENTS.md template (the extension injects the
 *   instructions itself).
 *
 * The memories live in ~/.optmem/memory, or in $MEMORY_DIR if set.
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
	writeSync,
	rmdirSync,
	truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** How the tool names itself in the messages it prints. */
export const ME = "memo";

/** The sizes a memory may override in its own `config` file. */
const KNOBS: Record<string, [number, string]> = {
	WAKE_LINES: [96, "the memory context: how many lines wake prints"],
	ENTRY_CHARS: [280, "the longest one memory may be, in bytes"],
	PART_CHARS: [20000, "output paging: largest part, in bytes"],
	PART_LINES: [500, "output paging: largest part, in lines"],
};

const RAW_MAX = 16; // blocks up to this many memories compress from the raw log

// Records are FIXED WIDTH, so a memory or a block is found by seeking to its
// offset — no scanning, no index file to keep in sync. Position IS identity.
const LOG_REC = 320;
const TREE_REC = 288;

class MemoError extends Error {}

function die(msg: string): never {
	throw new MemoError(msg);
}

/** A path as the user would type it: fold $HOME to ~. */
export function pretty(p: string): string {
	const a = resolve(p);
	const home = homedir();
	return a.startsWith(home + sep) ? "~" + a.slice(home.length) : a;
}

export function memoryDir(): string {
	const p = process.env.MEMORY_DIR || "~/.optmem/memory";
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

function byteLen(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

function plural(n: number, word: string): string {
	if (n === 1) return "1 " + word;
	if (word.endsWith("y")) word = word.slice(0, -1) + "ie";
	else if (/[shx]$/.test(word)) word += "e";
	return `${n} ${word}s`;
}

function today(): string {
	const t = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// ---------------------------------------------------------------- blocks

function coverAlpha(T: number, alpha: number): [number, number][] {
	let root = 1;
	while (root < T) root *= 2;
	const out: [number, number][] = [];
	const stack: [number, number][] = [[0, root]];
	while (stack.length) {
		const [lo, hi] = stack.pop()!;
		if (lo >= T) continue;
		const size = hi - lo;
		if (size > 1 && (hi > T || size > alpha * (T - lo))) {
			const mid = Math.floor((lo + hi) / 2);
			stack.push([mid, hi]);
			stack.push([lo, mid]);
		} else {
			out.push([lo, hi]);
		}
	}
	out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return out;
}

/** The blocks `memo wake` prints: at most `budget` of them, finest near T. */
function cover(T: number, budget: number): [number, number][] {
	if (T <= 0) return [];
	if (T <= budget) return Array.from({ length: T }, (_, i) => [i, i + 1] as [number, number]);
	let lo = 0.0;
	let hi = 1.0;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (coverAlpha(T, mid).length > budget) lo = mid;
		else hi = mid;
	}
	const out = coverAlpha(T, hi);
	// Block sizes jump in powers of two, so alpha alone can undershoot the
	// budget. Spend what is left on the present, where detail is worth most.
	while (out.length < budget) {
		let best = -1;
		for (let i = 0; i < out.length; i++) if (out[i][1] - out[i][0] > 1) best = i;
		if (best === -1) break;
		const [l, h] = out[best];
		const mid = Math.floor((l + h) / 2);
		out.splice(best, 1, [l, mid], [mid, h]);
	}
	return out;
}

// ---------------------------------------------------------------- store

/** The per-call context: the store dir plus the sizes after overrides. */
interface Ctx {
	d: string;
	knobs: { WAKE_LINES: number; ENTRY_CHARS: number; PART_CHARS: number; PART_LINES: number };
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function store(): string {
	const d = memoryDir();
	// The directory is only ever created by `memo init`: creating it IS
	// creating the identity, and that is a deliberate act.
	if (!isDir(d)) {
		die(
			`No memory at ${d}.\nTo create one, run: ${ME} init\n` +
				"To use an existing one, point MEMORY_DIR at it.",
		);
	}
	mkdirSync(join(d, "TREE"), { recursive: true });
	if (!existsSync(logPath(d))) closeSync(openSync(logPath(d), "a"));
	return d;
}

function size(k: string, v: string, where = ""): number {
	if (!/^\d+$/.test(v) || parseInt(v, 10) < 1) {
		die(`${where}${k} must be a positive whole number, not '${v}'.`);
	}
	const top = Math.min(TREE_REC - 8, LOG_REC - 40);
	if (k === "ENTRY_CHARS" && parseInt(v, 10) > top) {
		die(`${where}ENTRY_CHARS is at most ${top}: a memory has to fit the fixed-width records.`);
	}
	return parseInt(v, 10);
}

/** The knobs this memory sets for itself, read from its `config` file. */
function overrides(d: string): Record<string, number> {
	const out: Record<string, number> = {};
	const p = join(d, "config");
	if (!existsSync(p)) return out;
	readFileSync(p, "utf8")
		.split("\n")
		.forEach((raw, idx) => {
			const line = raw.split("#")[0].trim();
			if (!line.includes("=")) return;
			const eq = line.indexOf("=");
			const k = line.slice(0, eq).trim().toUpperCase();
			const v = line.slice(eq + 1).trim();
			const where = `${pretty(p)} line ${idx + 1}: `;
			if (!Object.hasOwn(KNOBS, k)) {
				die(`${where}${k} is not a size. Delete the line, or name one of: ${Object.keys(KNOBS).join(", ")}.`);
			}
			out[k] = size(k, v, where);
		});
	return out;
}

function writeConfig(d: string, over: Record<string, number>): void {
	const out = [
		"# OptMem sizes for this memory. A commented line means: follow the",
		`# tool's default. Edit with \`${ME} config NAME=VALUE\`.`,
		"",
	];
	for (const [k, [def, what]] of Object.entries(KNOBS)) {
		const prefix = Object.hasOwn(over, k) ? "" : "# ";
		out.push(`${prefix.padEnd(2)}${k.padEnd(12)} = ${String(Object.hasOwn(over, k) ? over[k] : def).padEnd(6)} # ${what}`);
	}
	writeFileSync(join(d, "config"), out.join("\n") + "\n", "utf8");
}

function logPath(d: string): string {
	return join(d, "LOG.txt");
}

function treePath(d: string, size: number): string {
	return join(d, "TREE", String(size));
}

function count(path: string, rec: number): number {
	try {
		return Math.floor(statSync(path).size / rec);
	} catch (e: any) {
		if (e?.code === "ENOENT") return 0; // any other failure is real and must surface
		throw e;
	}
}

function logLen(d: string): number {
	return count(logPath(d), LOG_REC);
}

/** Drop a partial trailing record left by a crash. Callers hold the lock. */
function repair(path: string, rec: number): void {
	let n: number;
	try {
		n = statSync(path).size;
	} catch (e: any) {
		if (e?.code === "ENOENT") return;
		throw e;
	}
	if (n % rec) truncateSync(path, n - (n % rec));
}

// ---------------------------------------------------------------- records

function parse(line: string): [number, string, string] {
	const sp1 = line.indexOf(" ");
	if (sp1 < 0) return [parseInt(line.slice(1), 10), "", ""];
	const head = line.slice(0, sp1);
	const rest = line.slice(sp1 + 1);
	const sp2 = rest.indexOf(" ");
	if (sp2 < 0) return [parseInt(head.slice(1), 10), rest, ""];
	return [parseInt(head.slice(1), 10), rest.slice(0, sp2), rest.slice(sp2 + 1)];
}

/** Decode a run of log records: sliced as BYTES, decoded one by one. */
function records(buf: Buffer): [number, string, string][] {
	const out: [number, string, string][] = [];
	for (let i = 0; i + LOG_REC <= buf.length; i += LOG_REC) {
		out.push(parse(buf.subarray(i, i + LOG_REC).toString("utf8").trimEnd()));
	}
	return out;
}

/** Memories [lo,hi) in one read. */
function logSlice(d: string, lo: number, hi: number): [number, string, string][] {
	const fd = openSync(logPath(d), "r");
	try {
		const buf = Buffer.alloc((hi - lo) * LOG_REC);
		const n = readSync(fd, buf, 0, buf.length, lo * LOG_REC);
		return records(buf.subarray(0, n));
	} finally {
		closeSync(fd);
	}
}

/** (id, date, text) of memory i, in one seek. */
function logGet(d: string, i: number): [number, string, string] {
	return logSlice(d, i, i + 1)[0];
}

/** Every memory, streamed. A search reads the whole log but must not HOLD it. */
function* logScan(d: string): Generator<[number, string, string]> {
	const fd = openSync(logPath(d), "r");
	try {
		const chunk = LOG_REC * 4096;
		const buf = Buffer.alloc(chunk);
		for (;;) {
			const n = readSync(fd, buf, 0, chunk, null);
			if (!n) return;
			yield* records(buf.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
}

/** The summary of block [lo,hi), in one seek. null if not built yet. */
function treeGet(d: string, lo: number, hi: number): string | null {
	const size = hi - lo;
	let rec: Buffer;
	try {
		const fd = openSync(treePath(d, size), "r");
		try {
			const buf = Buffer.alloc(TREE_REC);
			const n = readSync(fd, buf, 0, TREE_REC, Math.floor(lo / size) * TREE_REC);
			rec = buf.subarray(0, n);
		} finally {
			closeSync(fd);
		}
	} catch (e: any) {
		if (e?.code === "ENOENT") return null; // not built yet; any other failure is real
		throw e;
	}
	// Decode strictly, like Python's rec.decode(): invalid UTF-8 is a corrupt
	// summary, not garbage text. (A literal U+FFFD in a summary is fine.)
	let s: string;
	try {
		s = new TextDecoder("utf-8", { fatal: true }).decode(rec);
	} catch {
		die(`The summary of #${lo}-${hi - 1} is corrupt. Run: ${ME} forget ${lo}-${hi - 1}`);
	}
	return s!.trimEnd() || null;
}

function pad(text: string, rec: number): Buffer {
	const b = Buffer.from(text, "utf8");
	if (b.length > rec - 1) die(`Too long: ${b.length} bytes. The record holds ${rec - 1}.`);
	return Buffer.concat([b, Buffer.alloc(rec - 1 - b.length, 0x20), Buffer.from("\n")]);
}

// ---------------------------------------------------------------- lock

/** Exclusive, cross-process lock: an atomic mkdir with spin/backoff and stale
 * breaking. (The Python original uses flock; see the header comment.) */
function locked(d: string): () => void {
	const p = join(d, ".lockdir");
	const start = Date.now();
	const wait = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			mkdirSync(p);
			return () => {
				try {
					rmdirSync(p);
				} catch {
					/* already gone */
				}
			};
		} catch (e: any) {
			if (e?.code !== "EEXIST") throw e;
			try {
				// A crashed holder never releases; a live holder holds it for
				// milliseconds, so a lock far older than that is debris.
				if (Date.now() - statSync(p).mtimeMs > 60_000) {
					rmdirSync(p);
					continue;
				}
			} catch {
				/* vanished between stat and rmdir: retry */
				continue;
			}
			if (Date.now() - start > 30_000) die(`The memory at ${pretty(d)} is locked by another process.`);
			Atomics.wait(wait, 0, 0, 10);
		}
	}
}

/** Append memories; ids are assigned INSIDE the lock. Returns the first id. */
function logAppend(d: string, items: [string, string][]): number {
	const unlock = locked(d);
	try {
		repair(logPath(d), LOG_REC);
		const base = logLen(d);
		const fd = openSync(logPath(d), "a");
		try {
			items.forEach(([date, text], k) => {
				writeSync(fd, pad(`#${base + k} ${date} ${text}`, LOG_REC));
			});
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return base;
	} finally {
		unlock();
	}
}

/** Write block [lo,hi). Only ever appends one record to one level file. */
function treePut(d: string, lo: number, hi: number, text: string): boolean {
	const size = hi - lo;
	const unlock = locked(d);
	try {
		const p = treePath(d, size);
		repair(p, TREE_REC);
		if (count(p, TREE_REC) !== Math.floor(lo / size)) return false;
		const fd = openSync(p, "a");
		try {
			writeSync(fd, pad(text, TREE_REC));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return true;
	} finally {
		unlock();
	}
}

/** Forget block [lo,hi) and every block built from it. The log is untouched. */
function treeDrop(d: string, lo: number, hi: number): [number, number][] {
	const gone: [number, number][] = [];
	let size = hi - lo;
	const unlock = locked(d);
	try {
		while (size <= logLen(d)) {
			const p = treePath(d, size);
			const k = Math.floor(lo / size);
			const n = count(p, TREE_REC);
			if (n > k) {
				for (let i = k; i < n; i++) gone.push([i * size, (i + 1) * size]);
				truncateSync(p, k * TREE_REC);
			}
			size *= 2;
		}
		return gone;
	} finally {
		unlock();
	}
}

// ---------------------------------------------------------------- parsing

function blockId(s: string): [number, number] {
	const m = /^(\d+)-(\d+)$/.exec(s);
	if (!m) die(`'${s}' is not a block id. Copy it from the prompt.`);
	const lo = parseInt(m[1], 10);
	const hi = parseInt(m[2], 10) + 1;
	const n = hi - lo;
	if (n < 2 || n & (n - 1) || lo % n) {
		die(`${s} is not a block. Copy the id printed by wake, like 16-31.`);
	}
	return [lo, hi];
}

function check(ctx: Ctx, text: string): string {
	text = text.trim();
	if (!text) die("Empty. A memory is one line of text.");
	if (text.includes("\n") || text.includes("\r")) {
		die(`${text.split("\n").length} lines. A memory is one line: merge them, or note them separately.`);
	}
	const n = byteLen(text);
	if (n > ctx.knobs.ENTRY_CHARS) {
		die(`Too long: ${n} bytes, limit ${ctx.knobs.ENTRY_CHARS}. Accented characters cost 2 bytes. Compress it further.`);
	}
	return text;
}

// ---------------------------------------------------------------- naps

/** Blocks that can be built and have not been, smallest first. */
function pending(ctx: Ctx, T: number, limit?: number): [number, number][] {
	const todo: [number, number][] = [];
	let size = 2;
	while (size <= T) {
		const have = count(treePath(ctx.d, size), TREE_REC);
		for (let k = have; k < Math.floor(T / size); k++) {
			todo.push([k * size, (k + 1) * size]);
			if (limit && todo.length >= limit) return todo;
		}
		size *= 2;
	}
	return todo;
}

function pendingCount(ctx: Ctx, T: number): number {
	let n = 0;
	let size = 2;
	while (size <= T) {
		n += Math.max(0, Math.floor(T / size) - count(treePath(ctx.d, size), TREE_REC));
		size *= 2;
	}
	return n;
}

function napPrompt(ctx: Ctx, lo: number, hi: number, left: number): string {
	let body: string;
	if (hi - lo <= RAW_MAX) {
		body = logSlice(ctx.d, lo, hi)
			.map((e) => `  #${e[0]} ${e[1]} ${e[2]}`)
			.join("\n");
	} else {
		const mid = Math.floor((lo + hi) / 2);
		const halves: string[] = [];
		for (const [a, b] of [
			[lo, mid],
			[mid, hi],
		] as [number, number][]) {
			const s = treeGet(ctx.d, a, b);
			if (s === null) {
				die(`The summary of #${a}-${b - 1} is blank. Run: ${ME} forget ${a}-${b - 1}`);
			}
			halves.push(`  #${a}-${b - 1} ${s}`);
		}
		body = halves.join("\n");
	}
	const tail = !left
		? ""
		: `\n${left === 1 ? "1 compression remains" : `${left} compressions remain`} after this one.`;
	return (
		`Compress memories #${lo}-${hi - 1} into one line of at most ${ctx.knobs.ENTRY_CHARS} bytes.\n` +
		`Keep what has lasting effect, drop what does not. Invent nothing.\n\n` +
		`${body}\n${tail}\n` +
		`Run: ${ME} nap ${lo}-${hi - 1} "<your line>"`
	);
}

function nextNap(ctx: Ctx, T: number): string | null {
	const todo = pending(ctx, T, 1);
	if (!todo.length) return null;
	return napPrompt(ctx, todo[0][0], todo[0][1], pendingCount(ctx, T) - 1);
}

// ---------------------------------------------------------------- commands

function cmdInit(args: string[]): string {
	if (args.length) die(`usage: ${ME} init`);
	const d = memoryDir();
	const fresh = !isDir(d);
	mkdirSync(join(d, "TREE"), { recursive: true });
	closeSync(openSync(logPath(d), "a"));
	if (!existsSync(join(d, "config"))) writeConfig(d, {});
	overrides(d); // validate the config file, as the original does
	const head = fresh
		? `Created ${pretty(d)}: this machine's memory, one identity, forever.`
		: `Found ${pretty(d)}: ${plural(logLen(d), "memory")}.`;
	return `${head}\nSizes live in ${pretty(d)}/config; the defaults are fine.`;
}

/** Split the document into parts that survive any harness's output cap. */
function paginate(ctx: Ctx, lines: string[]): string[][] {
	const parts: string[][] = [];
	let cur: string[] = [];
	let size = 0;
	for (const line of lines) {
		const n = byteLen(line) + 1;
		if (cur.length && (cur.length >= ctx.knobs.PART_LINES || size + n > ctx.knobs.PART_CHARS)) {
			parts.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(line);
		size += n;
	}
	if (cur.length) parts.push(cur);
	return parts;
}

function cmdWake(ctx: Ctx, args: string[]): string {
	const now = logLen(ctx.d);
	let k = 1;
	let T = now;
	if (args.length) {
		if (args.length > 2 || !args.every((a) => /^\d+$/.test(a))) die(`usage: ${ME} wake [part [T]]`);
		k = parseInt(args[0], 10);
		if (args.length === 2) {
			T = parseInt(args[1], 10);
			if (T > now) die(`T=${T}, but the log holds ${plural(now, "memory")}. Run: ${ME} wake`);
		}
	}
	if (!T) {
		return `No memories yet. Record the first with: ${ME} note "<one line>"\nYou are awake.`;
	}
	const lines: string[] = [];
	for (const [lo, hi] of cover(T, ctx.knobs.WAKE_LINES)) {
		if (hi - lo === 1) {
			const e = logGet(ctx.d, lo);
			lines.push(`#${e[0]} ${e[1]} ${e[2]}`);
		} else {
			let s = treeGet(ctx.d, lo, hi);
			if (s === null) {
				const nap = nextNap(ctx, T);
				if (nap) {
					die(
						`Cannot wake: the memory context needs #${lo}-${hi - 1}, which is not compressed yet.\n` +
							`Do the ${plural(pendingCount(ctx, T), "compression")} below, then run ${ME} wake again.\n\n${nap}`,
					);
				}
				s = treeGet(ctx.d, lo, hi); // a parallel session may have paid it
			}
			if (s === null) {
				die(`The summary of #${lo}-${hi - 1} is blank. Run: ${ME} forget ${lo}-${hi - 1}`);
			}
			lines.push(`#${lo}-${hi - 1} ${s}`);
		}
	}
	const parts = paginate(ctx, lines);
	if (k < 1 || k > parts.length) {
		die(`No part ${k}: the memory has ${plural(parts.length, "part")}. Run: ${ME} wake`);
	}
	const out: string[] = [];
	if (parts.length > 1) {
		out.push(`Your memory, part ${k} of ${parts.length}, oldest first (${plural(T, "memory")}).`);
	}
	out.push(parts[k - 1].join("\n"));
	if (k < parts.length) {
		out.push(`Not awake yet. Run: ${ME} wake ${k + 1} ${T}`);
	} else {
		out.push("You are awake.");
		const nap = nextNap(ctx, T);
		if (nap) out.push("", nap);
	}
	return out.join("\n");
}

function cmdNote(ctx: Ctx, args: string[]): string {
	if (args.length !== 1) die(`usage: ${ME} note "<one line, at most ${ctx.knobs.ENTRY_CHARS} bytes>"`);
	const text = check(ctx, args[0]);
	const i = logAppend(ctx.d, [[today(), text]]);
	let out = `Saved as #${i}.`;
	const nap = nextNap(ctx, i + 1);
	if (nap) out += `\n\n${nap}`;
	return out;
}

function cmdNap(ctx: Ctx, args: string[]): string {
	const T = logLen(ctx.d);
	let said = false;
	const out: string[] = [];
	if (args.length) {
		said = true;
		if (args.length !== 2) die(`usage: ${ME} nap <lo>-<hi> "<one line>"`);
		const [lo, hi] = blockId(args[0]);
		const todo = pending(ctx, T, 1);
		if (!todo.length) return "Nothing left to compress.";
		if (lo !== todo[0][0] || hi !== todo[0][1]) {
			if (treeGet(ctx.d, lo, hi) !== null) {
				out.push(`${lo}-${hi - 1} is already settled.`);
			} else {
				die(`Wrong block: ${args[0]}. Blocks are built in order; the next is ${todo[0][0]}-${todo[0][1] - 1}. Run: ${ME} nap`);
			}
		} else if (!treePut(ctx.d, lo, hi, check(ctx, args[1]))) {
			out.push(`${lo}-${hi - 1} was settled or forgotten meanwhile.`);
		} else {
			out.push(`${lo}-${hi - 1} saved.`);
		}
	}
	const nap = nextNap(ctx, T);
	if (!nap) {
		out.push("Nothing left to compress.");
		return out.join("\n");
	}
	out.push((said ? "\n" : "") + nap);
	return out.join("\n");
}

function cmdConfig(ctx: Ctx, args: string[]): string {
	const over = overrides(ctx.d);
	for (const a of args) {
		const eq = a.indexOf("=");
		const k = (eq < 0 ? a : a.slice(0, eq)).trim().toUpperCase();
		const v = eq < 0 ? "" : a.slice(eq + 1).trim();
		if (eq < 0 || !Object.hasOwn(KNOBS, k)) {
			die(`usage: ${ME} config [NAME=VALUE ...]   # NAME one of ${Object.keys(KNOBS).join(", ")}`);
		}
		if (v) over[k] = size(k, v);
		else delete over[k];
	}
	if (args.length) writeConfig(ctx.d, over);
	return Object.entries(KNOBS)
		.map(
			([k, [def, what]]) =>
				`${k.padEnd(12)} ${String(Object.hasOwn(over, k) ? over[k] : def).padEnd(7)} ${what}${Object.hasOwn(over, k) ? ` (default ${def})` : ""}`,
		)
		.join("\n");
}

function cmdForget(ctx: Ctx, args: string[]): string {
	if (args.length !== 1) die(`usage: ${ME} forget <lo>-<hi>`);
	const [lo, hi] = blockId(args[0]);
	const gone = treeDrop(ctx.d, lo, hi);
	if (!gone.length) die(`No summary at ${args[0]}.`);
	return `Forgot ${plural(gone.length, "summary")}, from ${gone[0][0]}-${gone[0][1] - 1} up. Run: ${ME} nap`;
}

function cmdRecall(ctx: Ctx, args: string[]): string {
	if (args.length !== 1) die(`usage: ${ME} recall <regex>`);
	let pat: RegExp;
	try {
		pat = new RegExp(args[0], "iu");
	} catch (e) {
		die(`bad regex: ${(e as Error).message}`);
	}
	let hits = 0;
	let size = 0;
	const out: string[] = [];
	for (const e of logScan(ctx.d)) {
		const line = `#${e[0]} ${e[1]} ${e[2]}`;
		if (!pat.test(line)) continue;
		hits++;
		out.push(line);
		size += byteLen(line) + 1;
		while (size > ctx.knobs.PART_CHARS) size -= byteLen(out.shift()!) + 1;
	}
	if (!hits) return "No match.";
	const tail =
		out.length < hits
			? `Newest ${out.length} of ${plural(hits, "match")}. Narrow the regex.`
			: `${plural(hits, "match")}.`;
	return out.join("\n") + "\n" + tail;
}

function cmdZoom(ctx: Ctx, args: string[]): string {
	if (args.length !== 1) die(`usage: ${ME} zoom <lo>-<hi>   # a block id, as wake prints them`);
	const [lo, hi] = blockId(args[0]);
	const T = logLen(ctx.d);
	if (lo >= T) die(`#${args[0]} is beyond the memory: it holds ${plural(T, "memory")}. Run: ${ME} wake`);
	const mid = Math.floor((lo + hi) / 2);
	const out: string[] = [];
	for (const [a, b] of [
		[lo, mid],
		[mid, hi],
	] as [number, number][]) {
		if (a >= T) continue; // the future: no memories there yet
		if (b - a === 1) {
			const e = logGet(ctx.d, a);
			out.push(`#${e[0]} ${e[1]} ${e[2]}`);
		} else {
			out.push(`#${a}-${b - 1} ${treeGet(ctx.d, a, b) ?? "not compressed yet"}`);
		}
	}
	return out.join("\n");
}

function validDate(s: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (!m) return false;
	const d = new Date(+m[1], +m[2] - 1, +m[3]);
	return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

/** Bulk-append historical memories: 'YYYY-MM-DD <text>' per line. */
function cmdImport(ctx: Ctx, args: string[]): string {
	if (args.length !== 1) die(`usage: ${ME} import <file>   # lines of 'YYYY-MM-DD <text>'`);
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(args[0]));
	} catch {
		die(`${pretty(args[0])} is not UTF-8 text. Convert it, then import again.`);
	}
	let last = logLen(ctx.d) ? logGet(ctx.d, logLen(ctx.d) - 1)[1] : "0000-00-00";
	const out: [string, string][] = [];
	const lines = raw.split("\n");
	for (let i = 1; i <= lines.length; i++) {
		const line = lines[i - 1];
		if (!line.trim()) continue;
		const sp = line.indexOf(" ");
		const date = sp < 0 ? line : line.slice(0, sp);
		let text = sp < 0 ? "" : line.slice(sp + 1);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(`line ${i}: expected 'YYYY-MM-DD <text>', got: ${line}`);
		if (!validDate(date)) die(`line ${i}: ${date} is not a real date.`);
		if (date < last) die(`line ${i}: date ${date} precedes the previous memory (${last}).`);
		text = text.trim();
		const n = byteLen(text);
		if (!text || n > ctx.knobs.ENTRY_CHARS) die(`line ${i}: ${n} bytes, limit ${ctx.knobs.ENTRY_CHARS}.`);
		out.push([date, text]);
		last = date;
	}
	if (!out.length) die(`${pretty(args[0])} has no memories.`);
	const base = logAppend(ctx.d, out);
	let msg = `Imported ${plural(out.length, "memory")}, #${base} to #${base + out.length - 1}.`;
	const p = pendingCount(ctx, logLen(ctx.d));
	if (p) msg += `\n${plural(p, "compression")} pending. Run: ${ME} nap`;
	return msg;
}

// ---------------------------------------------------------------- entry

type Cmd = (ctx: Ctx, args: string[]) => string;

const COMMANDS: Record<string, Cmd> = {
	wake: cmdWake,
	note: cmdNote,
	nap: cmdNap,
	recall: cmdRecall,
	zoom: cmdZoom,
	forget: cmdForget,
	config: cmdConfig,
	import: cmdImport,
};

const USAGE = `OptMem (TypeScript port): a permanent, append-only memory for AI agents.

  ${ME} init             create this memory.
  ${ME} wake [part [T]]  read your memory. Run first, every session.
  ${ME} note "..."       record one memory: one short line.
  ${ME} nap [id "..."]   do the pending compressions.
  ${ME} recall <regex>   search every memory ever recorded.
  ${ME} zoom <lo>-<hi>   open a tree node: its two halves.
  ${ME} forget <lo>-<hi> drop a bad summary; nap rebuilds it.
  ${ME} config [NAME=N]  show this memory's sizes, or change one.
  ${ME} import <file>    bulk-load dated memories (bootstrap only).

The memories live in ~/.optmem/memory, or in $MEMORY_DIR if set.`;

export interface MemoResult {
	code: number;
	output: string;
}

/** Run one memo command, same contract as the Python CLI: exit code + text. */
export function runMemo(argv: string[]): MemoResult {
	try {
		const cmd = argv[0];
		if (!cmd) return { code: 0, output: USAGE };
		if (cmd === "init") return { code: 0, output: cmdInit(argv.slice(1)) };
		if (!Object.hasOwn(COMMANDS, cmd)) return { code: 1, output: `No such command: ${cmd}\n\n${USAGE}` };
		const d = store();
		const ctx: Ctx = {
			d,
			knobs: {
				WAKE_LINES: KNOBS.WAKE_LINES[0],
				ENTRY_CHARS: KNOBS.ENTRY_CHARS[0],
				PART_CHARS: KNOBS.PART_CHARS[0],
				PART_LINES: KNOBS.PART_LINES[0],
			},
		};
		Object.assign(ctx.knobs, overrides(d));
		return { code: 0, output: COMMANDS[cmd](ctx, argv.slice(1)) };
	} catch (e) {
		if (e instanceof MemoError) return { code: 1, output: (e as Error).message };
		const pe = e as NodeJS.ErrnoException;
		if (pe && typeof pe.code === "string") {
			const where = pe.path ? pretty(String(pe.path)) : memoryDir();
			return { code: 1, output: `${where}: ${String(pe.message).split(",")[0]}.` };
		}
		throw e;
	}
}

// CLI entry: `node memo.ts <command> [args]` (also used by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const res = runMemo(process.argv.slice(2));
	console.log(res.output);
	process.exit(res.code);
}
