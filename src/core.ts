/**
 * protokoll – pure logic (no Pi runtime): configuration, protocol block parsing,
 * turn bookkeeping, cut selection, the tiered compaction summary and turn search.
 *
 * Kept free of runtime calls so it can be unit-tested with plain data.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Configuration
// ============================================================================

export interface ProtocolConfig {
	/** Master switch. `/protokoll off` overrides it per session. */
	enabled: boolean;
	/** Tag name of the block the model writes, e.g. <protocol>…</protocol>. */
	tag: string;
	/** Soft length limit written into the system prompt. */
	maxWords: number;
	/** Remove the block from the stored answer (it lives on as a protocol entry). */
	strip: boolean;
	/** Ask the model again right after a final answer that carried no block. */
	followUp: boolean;
	/** Thinking level of the extension's requests WITHOUT the chat context (backfill from transcript, state, review); "off" turns thinking off. */
	followUpReasoning: "off" | "minimal" | "low" | "medium" | "high";
	/** Thinking level of the review of rules and open items (comparing every rule with the later ones profits from thinking). */
	consolidateReasoning: "off" | "minimal" | "low" | "medium" | "high";
	/** Output limit of requests that repeat the chat context (follow-up, backfill of the last turn); they think at the chat's level, and thinking counts against it. */
	followUpMaxTokens: number;
	/** Hard time limit for the follow-up request. */
	followUpTimeoutMs: number;
	/** "protocol": build the compaction summary from the protocol; "default": leave compaction to Pi. */
	compaction: "protocol" | "default";
	/** Let the model tidy rules and open items once per compaction (the turn log is never rewritten). */
	consolidate: boolean;
	/** Keep at most this many of the latest turns in full. */
	keepRecentTurns: number;
	/** …and at most this share of the context window (percent). The smaller limit wins. */
	keepRecentPercent: number;
	/** Quote every user message verbatim in the summary. */
	keepUserMessages: boolean;
	/** Longer user messages are cut in the summary (the original stays reachable via the tool). */
	userMessageMaxChars: number;
	/** Register the tool that returns the original text of an earlier turn. */
	lookupTool: boolean;
	/** Output limit of that tool, in tokens (≈ 4 characters each). */
	lookupMaxTokens: number;
	/** Size limit for each pinned turn inside the summary, in tokens. */
	pinnedMaxTokens: number;
	/** Size limit for the digest of a turn without protocol, in tokens. */
	digestMaxTokens: number;
	/** Hard limit for the detailed tier (newest condensed turns: user message + protocol). */
	detailMaxTokens: number;
	/** Hard limit for the status (rules, files, open items, state of work) covering everything older. */
	statusMaxTokens: number;
	/** Input size of one model call that folds turns into the state of work. */
	foldChunkTokens: number;
	/** Register the tool that searches earlier turns. */
	searchTool: boolean;
	/** Maximum hits returned by that tool. */
	searchMaxResults: number;
	/** Write the protocol of an interrupted turn afterwards: when the session continues, at the latest at compaction. */
	backfill: boolean;
	/** At most this many turns are backfilled from their transcript in one compaction. */
	backfillMaxPerCompaction: number;
	/** Input size of the transcript a backfill request reads, in tokens. */
	backfillTranscriptTokens: number;
	/** Output limit of a backfill request; thinking counts against it. */
	backfillMaxTokens: number;
}

export const DEFAULT_CONFIG: ProtocolConfig = {
	enabled: true,
	tag: "protocol",
	maxWords: 250,
	strip: true,
	followUp: true,
	followUpReasoning: "off",
	consolidateReasoning: "low",
	followUpMaxTokens: 16384,
	followUpTimeoutMs: 600_000,
	compaction: "protocol",
	consolidate: true,
	keepRecentTurns: 3,
	keepRecentPercent: 10,
	keepUserMessages: true,
	userMessageMaxChars: 4000,
	lookupTool: true,
	lookupMaxTokens: 8000,
	pinnedMaxTokens: 8000,
	digestMaxTokens: 1500,
	detailMaxTokens: 30000,
	statusMaxTokens: 8000,
	foldChunkTokens: 12000,
	searchTool: true,
	searchMaxResults: 10,
	backfill: true,
	backfillMaxPerCompaction: 8,
	backfillTranscriptTokens: 12000,
	backfillMaxTokens: 4096,
};

/** Lower bounds that keep the tiers workable. */
const MINIMUM: Partial<Record<keyof ProtocolConfig, number>> = {
	statusMaxTokens: 800,
	foldChunkTokens: 2000,
	searchMaxResults: 1,
	maxWords: 20,
	followUpMaxTokens: 128,
	backfillTranscriptTokens: 2000,
	backfillMaxTokens: 512,
};

export const CONFIG_FILE_NAME = "protokoll.json";

/** Validates one raw config object; unknown keys and wrong types are reported, not applied. */
export function mergeConfig(base: ProtocolConfig, raw: unknown, source: string, warnings: string[]): ProtocolConfig {
	if (raw === undefined || raw === null) return base;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${source}: erwartet ein JSON-Objekt`);
		return base;
	}
	const out: ProtocolConfig = { ...base };
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!(key in DEFAULT_CONFIG)) {
			warnings.push(`${source}: unknown key "${key}" ignored`);
			continue;
		}
		const k = key as keyof ProtocolConfig;
		const expected = typeof DEFAULT_CONFIG[k];
		if (typeof value !== expected) {
			warnings.push(`${source}: "${key}" must be of type ${expected} – ignored`);
			continue;
		}
		if (k === "compaction" && value !== "protocol" && value !== "default") {
			warnings.push(`${source}: "compaction" must be "protocol" or "default" – ignored`);
			continue;
		}
		if (
			(k === "followUpReasoning" || k === "consolidateReasoning") &&
			!["off", "minimal", "low", "medium", "high"].includes(value as string)
		) {
			warnings.push(`${source}: "${k}" invalid – ignored`);
			continue;
		}
		if (k === "tag" && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value as string)) {
			warnings.push(`${source}: "tag" may only contain letters, digits, - and _ – ignored`);
			continue;
		}
		if (expected === "number" && (!Number.isFinite(value as number) || (value as number) < 0)) {
			warnings.push(`${source}: "${key}" must be a non-negative number – ignored`);
			continue;
		}
		const min = MINIMUM[k];
		if (min !== undefined && (value as number) < min) {
			warnings.push(`${source}: "${key}" must be at least ${min} – ignored`);
			continue;
		}
		if (k === "keepRecentPercent" && (value as number) > 90) {
			warnings.push(`${source}: "keepRecentPercent" must be at most 90 – ignored`);
			continue;
		}
		(out as unknown as Record<string, unknown>)[k] = value;
	}
	return out;
}

/** Global file in the agent directory, then a project file in <cwd>/.pi/ (project wins). */
export function loadConfig(agentDir: string, cwd: string): { config: ProtocolConfig; warnings: string[] } {
	const warnings: string[] = [];
	let config = { ...DEFAULT_CONFIG };
	for (const file of [join(agentDir, CONFIG_FILE_NAME), join(cwd, ".pi", CONFIG_FILE_NAME)]) {
		if (!existsSync(file)) continue;
		try {
			config = mergeConfig(config, JSON.parse(readFileSync(file, "utf8")), file, warnings);
		} catch (error) {
			warnings.push(`${file}: unreadable (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return { config, warnings };
}

// ============================================================================
// The block the model writes
// ============================================================================

export interface ProtocolFields {
	result: string[];
	decision: string[];
	files: string[];
	open: string[];
	rule: string[];
	revoke: string[];
	/** One-line summary for the index, written by the model with the turn (absent in older protocols). */
	index?: string[];
	/** Search terms chosen by the model to find the turn again (absent in older protocols). */
	tags?: string[];
	other: string[];
}

const FIELD_ALIASES: Record<string, Exclude<keyof ProtocolFields, "other">> = {
	result: "result",
	results: "result",
	outcome: "result",
	decision: "decision",
	decisions: "decision",
	file: "files",
	files: "files",
	open: "open",
	todo: "open",
	todos: "open",
	rule: "rule",
	rules: "rule",
	revoke: "revoke",
	revoked: "revoke",
	index: "index",
	summary: "index",
	tags: "tags",
	tag: "tags",
	keywords: "tags",
};

export function isNoneItem(value: string): boolean {
	return /^(none|nothing|-|n\/a|keine|nichts)(\s+(new|further|more|neu|neue|neuen|weitere|weiteren))?(\s+(rules?|items?|vorgaben|punkte))?\.?$/i.test(
		value.trim(),
	);
}

export function emptyFields(): ProtocolFields {
	return { result: [], decision: [], files: [], open: [], rule: [], revoke: [], index: [], tags: [], other: [] };
}

export function systemPromptSection(config: ProtocolConfig): string {
	const t = config.tag;
	return [
		"At the very end of every final answer to the user (not in intermediate messages that call tools), append a protocol block.",
		"The harness removes it from the visible answer and uses it to keep long sessions within the context window, so it must stand on its own without the rest of the conversation.",
		"The block is plain text written at the end of your answer; it is not a tool, so never call a tool to write it.",
		"",
		`<${t}>`,
		"result: what this turn produced or answered, 1-3 sentences",
		"decision: one decision or agreement per line, repeat the key for more",
		"files: paths of files created or changed, comma separated, nothing else (no comments or commit ids)",
		'open: the complete list of items still open after this turn, one per line; write "open: none" when nothing is open',
		"rule: a standing instruction from the user about HOW to work that applies from now on, only if the user gave it IN THIS TURN, one per line; not a decision about the code, not a finding, not a plan; earlier rules are kept automatically, so never repeat them and leave the key out when there is no new one",
		"revoke: an earlier rule the user withdrew",
		"index: one line of at most 20 words that will stand for this turn among hundreds of others once the details are gone; name the subject and the outcome (what is now true, decided or known), not the activity",
		"tags: 3-6 search terms, comma separated, that you would type into protocol_search to find this turn again: the specific names of what it was about (identifiers, files, parameters, effects, and the user's own words for the topic in their language); no words that fit almost every turn of this session",
		`</${t}>`,
		"",
		`Leave out keys with nothing to report, except open. Stay under ${config.maxWords} words. Write the block in English, whatever language the conversation uses. Copy names, numbers, paths and identifiers exactly. Do not mention the block in your answer.`,
	].join("\n");
}

export const FOLLOW_UP_PROMPT = (tag: string) =>
	`Your previous answer did not end with the <${tag}> block. Write only that block for the turn above, exactly as the system prompt describes. Output nothing else.`;

/** The last turn stopped early (aborted, error, output limit); asked when the session continues or compacts. */
export const INTERRUPTED_PROMPT = (tag: string) =>
	`Your work on the turn above was interrupted before it finished. Do not continue it and do not call tools. Write only the <${tag}> block for that turn as the system prompt describes it: what was actually done so far, decisions taken, files changed, and under open what is still unfinished. Output nothing else.`;

/** The context is condensed while the turn is still running. */
export const PROGRESS_PROMPT = (tag: string) =>
	`The context is about to be condensed while you are still working on the turn above; you will continue afterwards. Do not call tools now. Write only the <${tag}> block for the work so far as the system prompt describes it, with everything still to do for this turn under open. Output nothing else.`;

/** index and tags for stored protocols that have none, several turns per request (/protokoll repair). */
export function supplementPrompt(items: { number: number; user: string; fields: ProtocolFields }[]): string {
	const blocks = items.map(({ number, user, fields }) =>
		[
			`### T${number}`,
			`User: ${user}`,
			...fields.result.map((r) => `Result: ${r}`),
			...fields.decision.map((d) => `Decision: ${d}`),
			...(fields.files.length ? [`Files: ${fields.files.join(", ")}`] : []),
		].join("\n"),
	);
	return [
		"Below are stored protocols of earlier turns of one long working session. Each lacks two lines that are needed for its index. Write them for every turn, based only on what is given:",
		"",
		"index: one line of at most 20 words that will stand for this turn among hundreds of others once the details are gone; name the subject and the outcome (what is now true, decided or known), not the activity",
		"tags: 3-6 search terms, comma separated, that you would type into a keyword search to find this turn again: the specific names of what it was about (identifiers, files, parameters, effects, and the user's own words for the topic in their language); no words that fit almost every turn of this session, and choose them so that these turns can be told apart",
		"",
		"Answer in English (the user's own words may stay in their language), in exactly this form and nothing else:",
		"T<number>",
		"index: ...",
		"tags: ...",
		"",
		...blocks,
	].join("\n");
}

/** Turn number -> index/tags from the answer to supplementPrompt; incomplete entries are left out. */
export function parseSupplement(text: string): Map<number, { index: string[]; tags: string[] }> {
	const out = new Map<number, { index: string[]; tags: string[] }>();
	let current: { index: string[]; tags: string[] } | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim().replace(/^[-*•#\s]+/, "");
		const head = /^\[?T(\d+)\]?:?$/i.exec(line);
		if (head) {
			current = { index: [], tags: [] };
			out.set(Number(head[1]), current);
			continue;
		}
		const m = /^(index|tags)\s*:\s*(.+)$/i.exec(line);
		if (m && current) current[m[1].toLowerCase() as "index" | "tags"].push(m[2].trim());
	}
	for (const [n, v] of out) if (!v.index.length || !v.tags.length) out.delete(n);
	return out;
}

/** Protocol of an earlier turn written from its transcript (no conversation context). */
export function backfillPrompt(config: ProtocolConfig, turnNumber: number, transcript: string): string {
	return [
		`Below is the transcript of turn ${turnNumber} of a long working session between a user and an assistant with tools. No protocol was written for it.`,
		"Write the protocol block for this turn in the following format. Base it only on the transcript; when the turn was interrupted, describe what was done so far and put unfinished work under open.",
		"",
		systemPromptSection(config),
		"",
		"<transcript>",
		transcript,
		"</transcript>",
		"",
		`Output only the <${config.tag}> block.`,
	].join("\n");
}

/**
 * Finds the last <tag>…</tag> block. An opening tag without a closing one counts as a block
 * running to the end of the text (the model stopped early).
 */
export function extractBlock(text: string, tag: string): { body: string | undefined; rest: string } {
	const open = new RegExp(`<${tag}>`, "gi");
	let lastOpen = -1;
	let lastOpenLen = 0;
	for (let m = open.exec(text); m; m = open.exec(text)) {
		lastOpen = m.index;
		lastOpenLen = m[0].length;
	}
	if (lastOpen < 0) return { body: undefined, rest: text };
	const after = text.slice(lastOpen + lastOpenLen);
	const close = new RegExp(`</${tag}>`, "i").exec(after);
	const body = close ? after.slice(0, close.index) : after;
	const tail = close ? after.slice(close.index + close[0].length) : "";
	const rest = (text.slice(0, lastOpen).replace(/\s+$/, "") + (tail.trim() ? `\n\n${tail.trim()}` : "")).trimEnd();
	return { body: body.trim(), rest };
}

/** Hides complete blocks and, while streaming, a block that has started but not finished. */
export function hideBlocks(markdown: string, tag: string, streaming: boolean): string {
	let out = markdown.replace(new RegExp(`\\s*<${tag}>[\\s\\S]*?</${tag}>\\s*`, "gi"), "\n");
	if (streaming) {
		const idx = out.search(new RegExp(`<${tag}>`, "i"));
		if (idx >= 0) out = out.slice(0, idx);
		// an opening tag that is still being typed: "<pro", "<protoc"…
		const lt = out.lastIndexOf("<");
		if (
			lt >= 0 &&
			out.length - lt <= tag.length + 1 &&
			`<${tag}>`.toLowerCase().startsWith(out.slice(lt).toLowerCase())
		) {
			out = out.slice(0, lt);
		}
	}
	return out.trimEnd();
}

/** "key: value" lines; lines without a known key continue the previous key. */
export function parseBlock(body: string): ProtocolFields | undefined {
	const fields = emptyFields();
	let current: keyof ProtocolFields | undefined;
	let any = false;
	const push = (k: keyof ProtocolFields, v: string) => {
		fields[k] = [...(fields[k] ?? []), v];
	};
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const m = /^[-*•]?\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
		const key = m ? FIELD_ALIASES[m[1].toLowerCase()] : undefined;
		if (m && key) {
			current = key;
			const value = m[2].trim();
			if (value) {
				push(key, value);
				any = true;
			}
			continue;
		}
		const value = line.replace(/^[-*•]\s*/, "");
		if (current) push(current, value);
		else fields.other.push(value);
		any = true;
	}
	if (!any) return undefined;
	// "open: none" stays in the list: it marks an explicitly empty list (see currentOpenItems)
	return fields;
}

// ============================================================================
// Session data in plain form
// ============================================================================

/** The parts of Pi's session entries this module reads. */
export interface PlainEntry {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
	message?: PlainMessage;
	summary?: string;
	firstKeptEntryId?: string | null;
	tokensBefore?: number;
	timestamp?: string;
	details?: unknown;
}

export interface PlainMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	stopReason?: string;
	errorMessage?: string;
}

export const PROTOCOL_ENTRY = "protokoll";
export const PIN_ENTRY = "protokoll-pin";
export const STATE_ENTRY = "protokoll-state";
/** Marker: rebuild the state of work at the next compaction (/protokoll rebuild). */
export const REBUILD_ENTRY = "protokoll-rebuild";
/** index/tags written later for a protocol that has none (/protokoll repair). The German name is stored in sessions and stays. */
export const SUPPLEMENT_ENTRY = "protokoll-ergaenzung";
/** How the last compaction pass went, with the time of every step. Written by the extension itself. */
export const COMPACT_ENTRY = "protokoll-compact";

export interface SupplementEntryData {
	userEntryId: string;
	turn: number;
	index: string[];
	tags: string[];
}

export interface CompactStepData {
	label: string;
	/** wait becomes skipped: the pass ended before this step ran. */
	state: "ok" | "fail" | "skipped";
	/** wall time of the step in ms, 0 when it never ran */
	ms: number;
	note?: string;
}

/** What the compaction pass did – the numbers, shared by the entry and the export. */
export interface CompactCounts {
	tokensBefore?: number;
	condensedTurns?: number;
	detailTurns?: number;
	keptTurns?: number;
	missingTurns?: number;
	backfilled?: number;
	newlyFolded?: number;
	pending?: number;
	dropped?: string[];
	error?: string;
}

export interface CompactEntryData extends CompactCounts {
	version: 1;
	/** protocol: this extension wrote the summary; no_room or failed: Pi summarizes instead. */
	outcome: "protocol" | "no_room" | "failed";
	/** when the pass started and how long it took */
	startedAt: string;
	durationMs: number;
	/** the steps of the progress widget, with their times */
	steps: CompactStepData[];
	/** the lines the user saw as notifications during the pass */
	notes: string[];
}

/**
 * Live line of a running pass on the shared extension bus (`pi.events`). Nothing is stored in the
 * session here: the durable record stays the single COMPACT_ENTRY above. pi-webapp shows these
 * lines in the browser, the console shows them as its widget.
 */
export const PROGRESS_CHANNEL = "pi-protokoll:progress";

export interface ProgressStep {
	version: 1;
	/** session of the run, so a listener can ignore other sessions */
	session: string;
	/** heading of the progress bar as the user sees it */
	title: string;
	/** 1-based index of the current step */
	step: number;
	/** total number of steps of the run */
	steps: number;
	/** label of the current step */
	label: string;
	state: "wait" | "run" | "ok" | "fail";
	/** wall time of the whole run so far */
	ms: number;
	/** last line of the run: the durable entry follows right after it */
	closed: boolean;
}

export interface ProgressEvent extends ProgressStep {
	/** which kind of run reports: compaction, repair, ... */
	run: string;
}

/** Seconds and minutes as a user reads them. */
export function compactDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
	return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** One line for the console and for /protokoll export: what the pass did and how long it took. */
export function compactStatusLine(d: CompactEntryData): string {
	const head = `compaction in ${compactDuration(d.durationMs)}`;
	if (d.outcome === "no_room") return `${head}: no room – Pi summarizes`;
	if (d.outcome === "failed") return `${head}: failed – Pi summarizes`;
	const parts = [
		`${d.condensedTurns ?? 0} turns condensed`,
		`${d.detailTurns ?? 0} in detail`,
		`${d.keptTurns ?? 0} kept in full`,
	];
	if (d.missingTurns) parts.push(`${d.missingTurns} without protocol`);
	if (d.backfilled) parts.push(`${d.backfilled} written afterwards`);
	if (d.newlyFolded) parts.push(`${d.newlyFolded} newly folded`);
	if (d.pending) parts.push(`${d.pending} not folded yet`);
	if (d.dropped?.length) parts.push(`limit reached: ${d.dropped.join(", ")}`);
	return `${head}: ${parts.join(", ")}`;
}

/** True when /protokoll rebuild was given after the last compaction written by this extension. */
export function rebuildRequested(branch: PlainEntry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === REBUILD_ENTRY) return true;
		if (e.type === "compaction" && (e.details as { protokoll?: boolean } | undefined)?.protokoll === true)
			return false;
	}
	return false;
}

export interface ProtocolEntryData {
	version: 1;
	userEntryId: string;
	turn: number;
	/** inline: in the answer; followup: asked right after it; backfill: written later for an interrupted or missing turn. */
	source: "inline" | "followup" | "backfill" | "missing";
	fields?: ProtocolFields;
	raw?: string;
}

export interface PinEntryData {
	userEntryId: string;
	pinned: boolean;
}

export interface StateEntryData {
	enabled: boolean;
}

/**
 * A turn is one run of the agent: the user message that started it, every message the user sent
 * while the agent was still working (steering), and all answers and tool calls up to the end.
 */
export interface Turn {
	/** 1-based, counted over runs on the current branch. */
	number: number;
	/** Id of the user message that started the run; protocols and pins are keyed by it. */
	userEntryId: string;
	/** Ids of all user messages in the run, the starting one first. */
	userEntryIds: string[];
	/** Position of the starting user message in the branch array. */
	index: number;
	/** Entries from the starting user message up to (excluding) the next run. */
	entries: PlainEntry[];
}

export function isUserMessage(e: PlainEntry): boolean {
	return e.type === "message" && e.message?.role === "user";
}

/**
 * True when a user message arrived while the agent was working: the message before it is a tool
 * result or an answer that asked for tools. Such a message continues the running turn.
 */
export function isSteering(branch: PlainEntry[], index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "toolResult") return true;
		if (m.role === "assistant") return m.stopReason === "toolUse";
		return false;
	}
	return false;
}

/** Entries Pi removed from the model's context (context_edit with replacement null, latest edit wins). */
export function omittedEntries(branch: PlainEntry[]): Set<string> {
	const latest = new Map<string, boolean>();
	for (const e of branch) {
		const edit = e as PlainEntry & { targetId?: string; replacement?: unknown };
		if (e.type === "context_edit" && typeof edit.targetId === "string")
			latest.set(edit.targetId, edit.replacement === null);
	}
	return new Set([...latest].filter(([, omitted]) => omitted).map(([id]) => id));
}

export function collectTurns(branch: PlainEntry[]): Turn[] {
	const turns: Turn[] = [];
	// answers Pi took back out of the context (e.g. a failed overflow recovery) are not part of a turn
	const omitted = omittedEntries(branch);
	for (let i = 0; i < branch.length; i++) {
		const e = branch[i];
		const current = turns[turns.length - 1];
		if (omitted.has(e.id) && !isUserMessage(e)) continue;
		if (isUserMessage(e) && !(current && isSteering(branch, i))) {
			turns.push({ number: turns.length + 1, userEntryId: e.id, userEntryIds: [e.id], index: i, entries: [e] });
		} else if (current) {
			current.entries.push(e);
			if (isUserMessage(e)) current.userEntryIds.push(e.id);
		}
	}
	return turns;
}

/** Maps every user message id to the id of the message that started its turn. */
function turnStarts(branch: PlainEntry[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const t of collectTurns(branch)) for (const id of t.userEntryIds) map.set(id, t.userEntryId);
	return map;
}

/** Position of every user message inside its turn (0 = the message that started it). */
function positionsInTurn(branch: PlainEntry[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const t of collectTurns(branch)) for (let i = 0; i < t.userEntryIds.length; i++) map.set(t.userEntryIds[i], i);
	return map;
}

/**
 * Protocol per turn, keyed by the turn's starting message. Several entries can belong to one turn
 * when older versions stored protocols under messages sent while the agent worked. The entry for
 * the LATEST of those messages wins, because it was written with the most of the run in view; among
 * entries for the same message the later one wins. A "missing" marker never replaces a written
 * protocol.
 */
export function collectProtocols(branch: PlainEntry[]): Map<string, ProtocolEntryData> {
	const starts = turnStarts(branch);
	const positions = positionsInTurn(branch);
	const map = new Map<string, { data: ProtocolEntryData; rank: number }>();
	for (const e of branch) {
		if (e.type === "custom" && e.customType === PROTOCOL_ENTRY && e.data && typeof e.data === "object") {
			const d = e.data as ProtocolEntryData;
			if (typeof d.userEntryId !== "string") continue;
			const key = starts.get(d.userEntryId) ?? d.userEntryId;
			const rank = positions.get(d.userEntryId) ?? 0;
			const prev = map.get(key);
			if (prev) {
				if (!d.fields && prev.data.fields) continue;
				if (d.fields && prev.data.fields && rank < prev.rank) continue;
			}
			map.set(key, { data: d, rank });
		}
	}
	// index and tags added later fill in what a protocol lacks; they never replace the model's own
	for (const e of branch) {
		if (e.type !== "custom" || e.customType !== SUPPLEMENT_ENTRY || !e.data || typeof e.data !== "object") continue;
		const s = e.data as SupplementEntryData;
		const prev = map.get(starts.get(s.userEntryId) ?? s.userEntryId);
		const f = prev?.data.fields;
		if (!prev || !f) continue;
		prev.data = {
			...prev.data,
			fields: {
				...f,
				index: f.index?.length ? f.index : s.index,
				tags: f.tags?.length ? f.tags : s.tags,
			},
		};
	}
	return new Map([...map].map(([k, v]) => [k, v.data]));
}

export function collectPins(branch: PlainEntry[]): Set<string> {
	const starts = turnStarts(branch);
	const pins = new Set<string>();
	for (const e of branch) {
		if (e.type === "custom" && e.customType === PIN_ENTRY && e.data && typeof e.data === "object") {
			const d = e.data as PinEntryData;
			const key = starts.get(d.userEntryId) ?? d.userEntryId;
			if (d.pinned) pins.add(key);
			else pins.delete(key);
		}
	}
	return pins;
}

/** All user messages of a turn; messages sent while the agent worked are marked. */
export function turnUserText(entries: PlainEntry[], maxChars = Infinity, note = "shortened"): string {
	const parts: string[] = [];
	for (const e of entries) {
		if (!isUserMessage(e)) continue;
		const text = clip(contentText(e.message?.content), maxChars, note);
		parts.push(parts.length ? `[while the assistant worked] ${text}` : text);
	}
	return parts.join("\n");
}

export function sessionEnabled(branch: PlainEntry[], fallback: boolean): boolean {
	let enabled = fallback;
	for (const e of branch) {
		if (e.type === "custom" && e.customType === STATE_ENTRY && e.data && typeof e.data === "object") {
			enabled = (e.data as StateEntryData).enabled !== false;
		}
	}
	return enabled;
}

// ============================================================================
// Text helpers
// ============================================================================

export function contentText(content: unknown, imageMarker = "[image]"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "image") parts.push(imageMarker);
	}
	return parts.join("\n");
}

export function clip(text: string, maxChars: number, note: string): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n[… ${text.length - maxChars} characters cut – ${note}]`;
}

function toolCallText(block: Record<string, unknown>, maxArgChars: number): string {
	const args =
		block.arguments && typeof block.arguments === "object" ? (block.arguments as Record<string, unknown>) : {};
	const argText = Object.entries(args)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(", ");
	return `${String(block.name)}(${argText.length > maxArgChars ? `${argText.slice(0, maxArgChars)}…` : argText})`;
}

/**
 * Text form of a turn. Thinking is left out; tool results are cut to `toolResultChars`
 * (0 = names only).
 */
export function serializeTurn(entries: PlainEntry[], toolResultChars: number, assistantChars = Infinity): string {
	const parts: string[] = [];
	for (const e of entries) {
		if (e.type === "branch_summary" && e.summary) {
			parts.push(`[Summary of a side branch the user left]: ${e.summary}`);
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "user") {
			parts.push(`[User]: ${contentText(m.content)}`);
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			const texts: string[] = [];
			const calls: string[] = [];
			for (const block of m.content as Record<string, unknown>[]) {
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
				else if (block?.type === "toolCall") calls.push(toolCallText(block, toolResultChars > 0 ? 400 : 120));
			}
			const text = texts.join("\n").trim();
			if (text)
				parts.push(`[Assistant]: ${assistantChars < text.length ? clip(text, assistantChars, "shortened") : text}`);
			if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (m.role === "toolResult") {
			if (toolResultChars <= 0) continue;
			const text = contentText(m.content);
			if (text) parts.push(`[Tool result ${m.toolName ?? ""}]: ${clip(text, toolResultChars, "shortened")}`);
		} else if (m.role === "bashExecution") {
			const b = m as PlainMessage & { command?: string; output?: string; excludeFromContext?: boolean };
			if (!b.excludeFromContext && b.command)
				parts.push(`[User ran in the shell]: ${b.command}\n${clip(b.output ?? "", 1200, "output shortened")}`);
		} else if (m.role === "custom") {
			const text = contentText(m.content);
			if (text) parts.push(`[Note]: ${clip(text, 600, "shortened")}`);
		}
	}
	return parts.join("\n\n");
}

// ============================================================================
// Cut selection
// ============================================================================

export interface CutChoice {
	/** Entry id of the user message the kept part starts with. */
	firstKeptEntryId: string;
	/** Turns kept in full. */
	keptTurns: number;
	keptTokens: number;
}

/**
 * Keeps the latest whole turns: at most `keepTurns`, at most `budgetTokens`, and never all of them.
 * Returns undefined when not even the last turn fits; the caller then uses Pi's own cut,
 * which may land inside that turn.
 */
export function chooseCut(
	branch: PlainEntry[],
	turns: Turn[],
	keepTurns: number,
	budgetTokens: number,
	estimate: (e: PlainEntry) => number,
): CutChoice | undefined {
	if (turns.length < 2) return undefined;
	const maxKeep = Math.min(Math.max(1, Math.floor(keepTurns)), turns.length - 1);
	const suffix: number[] = new Array(branch.length + 1).fill(0);
	for (let i = branch.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + estimate(branch[i]);
	for (let k = maxKeep; k >= 1; k--) {
		const turn = turns[turns.length - k];
		const tokens = suffix[turn.index];
		if (tokens <= budgetTokens) return { firstKeptEntryId: turn.userEntryId, keptTurns: k, keptTokens: tokens };
	}
	return undefined;
}

// ============================================================================
// Sizes
// ============================================================================

/** One line of at most n characters. */
export function short(text: string, n: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length <= n ? one : `${one.slice(0, Math.max(0, n - 1))}…`;
}

/** Conservative token estimate for limits (English text ≈ 4 characters per token). */
export function tok(text: string): number {
	return Math.ceil(text.length / 3.5);
}

/** Cuts text to a token budget, preferably at a sentence or line end. */
export function clipToTokens(text: string, maxTokens: number, note = "cut at the size limit"): string {
	if (tok(text) <= maxTokens) return text;
	const marker = ` […${note}]`;
	const maxChars = Math.max(0, Math.floor(maxTokens * 3.5) - marker.length);
	let cut = text.slice(0, maxChars);
	const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
	if (end > maxChars * 0.6) cut = cut.slice(0, end + 1);
	return `${cut.trimEnd()}${marker}`;
}

/** Cuts text to a token budget keeping its start and (the larger part) its end; the middle is dropped. */
export function clipMiddle(text: string, maxTokens: number, note = "middle cut"): string {
	if (tok(text) <= maxTokens) return text;
	const marker = `\n[… ${note} …]\n`;
	const chars = Math.max(0, Math.floor(maxTokens * 3.5) - marker.length);
	const head = Math.floor(chars * 0.35);
	const tail = chars - head;
	let a = text.slice(0, head);
	const ae = a.lastIndexOf("\n");
	if (ae > head * 0.6) a = a.slice(0, ae);
	let b = text.slice(text.length - tail);
	const bs = b.indexOf("\n");
	if (bs >= 0 && bs < tail * 0.4) b = b.slice(bs + 1);
	return `${a.trimEnd()}${marker}${b.trimStart()}`;
}

/** Keeps items from the front while they fit; reports how many were left out. */
export function fitList(
	items: string[],
	maxTokens: number,
	render: (s: string) => string,
): { kept: string[]; dropped: number } {
	const kept: string[] = [];
	let used = 0;
	for (const item of items) {
		const t = tok(render(item)) + 1;
		if (used + t > maxTokens) break;
		kept.push(item);
		used += t;
	}
	return { kept, dropped: items.length - kept.length };
}

// ============================================================================
// Rules, open items, files
// ============================================================================

const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/** Rules in order of appearance; a revoke removes every rule that contains it (or is contained by it). */
export function activeRules(protocols: ProtocolEntryData[], initial: string[] = []): string[] {
	let rules: string[] = [...initial];
	for (const p of protocols) {
		if (!p.fields) continue;
		for (const r of p.fields.revoke) {
			const nr = norm(r);
			if (nr) rules = rules.filter((x) => !norm(x).includes(nr) && !nr.includes(norm(x)));
		}
		for (const r of p.fields.rule) {
			if (isNoneItem(r)) continue;
			// the same rule restated in other words replaces the older wording
			rules = rules.filter((x) => similarity(x, r) < 0.6);
			rules.push(r);
		}
	}
	return rules;
}

const STOPWORDS = new Set(
	"a an the and or of to in on for with by is are be as at it its this that from not no only also when then than so if into per".split(
		" ",
	),
);

/** Content words of a text (lower case, no stop words). */
function contentWords(text: string): Set<string> {
	return new Set(
		norm(text)
			.split(" ")
			.filter((w) => w && !STOPWORDS.has(w)),
	);
}

/** Jaccard similarity of the content words of two texts (0..1). */
export function similarity(a: string, b: string): number {
	const x = contentWords(a);
	const y = contentWords(b);
	if (!x.size || !y.size) return norm(a) === norm(b) ? 1 : 0;
	let common = 0;
	for (const w of x) if (y.has(w)) common++;
	return common / (x.size + y.size - common);
}

/**
 * A file entry as the model wrote it, reduced to the path: comments in brackets and after a dash
 * are removed; entries that are no path at all ("earlier commit 9151618 …") are dropped.
 */
export function cleanFileEntry(entry: string): string | undefined {
	let f = entry.trim().replace(/^[`'"]+|[`'"]+$/g, "");
	f = f
		.replace(/\s+\([^)]*\)\s*$/, "")
		.replace(/\s+[—–-]\s.*$/, "")
		.trim();
	if (!f || /\s/.test(f) || isNoneItem(f)) return undefined;
	return f;
}

/** The latest protocol that states open items at all (an explicit "none" counts) is authoritative. */
export function currentOpenItems(protocols: ProtocolEntryData[]): string[] {
	const last = [...protocols].reverse().find((p) => (p.fields?.open.length ?? 0) > 0);
	return (last?.fields?.open ?? []).filter((o) => !isNoneItem(o));
}

/** Splits at commas that are not inside (), [] or {} – "a/{1,2}.ppm, b.c" gives two items. */
export function splitList(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of text) {
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
		if ((ch === "," || ch === ";") && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

/** Tools whose calls change a file, with the argument names that hold its path. */
const WRITING_TOOLS = new Set(["edit", "write", "multiedit", "multi_edit", "str_replace", "create"]);
const PATH_ARGS = ["path", "file_path", "filePath", "file"];

/** Files changed by edit/write tool calls of a turn (relative to cwd when below it). */
export function toolCallFiles(entries: PlainEntry[], cwd?: string): string[] {
	const out: string[] = [];
	const base = cwd ? `${cwd.replace(/\/+$/, "")}/` : undefined;
	for (const e of entries) {
		const m = e.message;
		if (e.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as Record<string, unknown>[]) {
			if (block?.type !== "toolCall" || !WRITING_TOOLS.has(String(block.name).toLowerCase())) continue;
			const args = (block.arguments ?? {}) as Record<string, unknown>;
			const key = PATH_ARGS.find((k) => typeof args[k] === "string" && (args[k] as string).trim());
			if (!key) continue;
			let path = (args[key] as string).trim();
			if (base && path.startsWith(base)) path = path.slice(base.length);
			if (!out.includes(path)) out.push(path);
		}
	}
	return out;
}

/**
 * Files named in protocols and changed by tool calls, most recently touched first, with the turn
 * that touched them last.
 */
export function touchedFiles(
	protocols: ProtocolEntryData[],
	turns: Turn[] = [],
	cwd?: string,
): { path: string; turn: number }[] {
	const last = new Map<string, number>();
	const base = cwd ? `${cwd.replace(/\/+$/, "")}/` : undefined;
	const note = (path: string, turn: number) => {
		const cleaned = cleanFileEntry(path);
		if (!cleaned) return;
		let f = cleaned.replace(/^\.\//, "");
		// protocols name files absolute or relative; one spelling per file
		if (base && f.startsWith(base)) f = f.slice(base.length);
		if (f && !isNoneItem(f) && (last.get(f) ?? 0) <= turn) last.set(f, turn);
	};
	for (const p of protocols)
		for (const entry of p.fields?.files ?? []) for (const f of splitList(entry)) note(f, p.turn);
	for (const t of turns) for (const f of toolCallFiles(t.entries, cwd)) note(f, t.number);
	return [...last.entries()].map(([path, turn]) => ({ path, turn })).sort((a, b) => b.turn - a.turn);
}

/**
 * Summaries Pi wrote for side branches the user left (/tree with summary). They are part of the
 * model's context and sit inside the turn after which the user switched branches.
 */
export function branchSummaries(entries: PlainEntry[]): string[] {
	return entries
		.filter((e) => e.type === "branch_summary" && typeof e.summary === "string" && e.summary.trim())
		.map((e) => (e.summary as string).trim());
}

/**
 * Shell commands the user ran himself with "!" (not "!!", which stays out of the model's context).
 * Their output reached the model like a user message, so it is kept in the condensed turn too.
 */
export function userShellRuns(entries: PlainEntry[], maxChars: number): string[] {
	const out: string[] = [];
	for (const e of entries) {
		const m = e.message as
			| (PlainMessage & { command?: string; output?: string; excludeFromContext?: boolean })
			| undefined;
		if (e.type !== "message" || m?.role !== "bashExecution" || m.excludeFromContext || !m.command) continue;
		out.push(`User ran in the shell: ${m.command}\n${clip((m.output ?? "").trim(), maxChars, "output shortened")}`);
	}
	return out;
}

/** True when the turn has any assistant output or tool activity (worth a protocol). */
export function turnHasWork(turn: Turn): boolean {
	return turn.entries.some(
		(e) =>
			e.type === "message" &&
			e.message?.role === "assistant" &&
			Array.isArray(e.message.content) &&
			(e.message.content as Record<string, unknown>[]).some(
				(b) => (b?.type === "text" && String(b.text ?? "").trim()) || b?.type === "toolCall",
			),
	);
}

/** The protocol entries of the branch, with protocols written during this compaction laid over them. */
export function protocolsWith(
	branch: PlainEntry[],
	extra?: Map<string, ProtocolEntryData>,
): Map<string, ProtocolEntryData> {
	const map = collectProtocols(branch);
	for (const [id, p] of extra ?? []) if (p.fields) map.set(id, p);
	return map;
}

// ============================================================================
// Fold state: which turns the model-written "state of work" covers
// ============================================================================

export interface FoldState {
	/** 2: turn numbers counted per user message (before steering was merged); 3: per run. */
	version: 2 | 3;
	/** Model-written description of where the work stands, covering the folded turns. */
	narrative: string;
	/** Folded turn numbers as ranges, e.g. "1-40,45". */
	folded: string;
	/** Ids of compactions written by Pi (or older versions) already merged into the narrative. */
	foreignConsumed: string[];
	/** Rule list after the last review; later compactions start from it instead of all protocols. */
	rules?: string[];
	/** Turns up to this number are already contained in `rules`. */
	rulesThrough?: number;
}

export function encodeRanges(numbers: Iterable<number>): string {
	const sorted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
		i = j + 1;
	}
	return parts.join(",");
}

export function decodeRanges(text: string | undefined): Set<number> {
	const out = new Set<number>();
	for (const part of (text ?? "").split(",")) {
		const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
		if (!m) continue;
		const a = Number(m[1]);
		const b = m[2] ? Number(m[2]) : a;
		for (let n = a; n <= b && n - a < 100_000; n++) out.add(n);
	}
	return out;
}

function isOwnCompaction(e: PlainEntry): boolean {
	const d = e.details as Record<string, unknown> | undefined;
	return e.type === "compaction" && !!d && d.protokoll === true;
}

/** The fold state of the latest compaction this extension wrote before `before`. */
export function latestFoldState(branch: PlainEntry[], before: number): FoldState | undefined {
	for (let i = Math.min(before, branch.length) - 1; i >= 0; i--) {
		const e = branch[i];
		if (!isOwnCompaction(e)) continue;
		const status = (e.details as { status?: FoldState }).status;
		if (!status || typeof status.narrative !== "string") continue;
		if (status.version === 3) return status;
		if (status.version === 2) return renumberLegacyState(branch, status);
	}
	return undefined;
}

/** Converts a state written when every user message counted as a turn to the run numbering. */
export function renumberLegacyState(branch: PlainEntry[], state: FoldState): FoldState {
	const userIds = branch.filter(isUserMessage).map((e) => e.id);
	const numberOf = new Map<string, number>();
	for (const t of collectTurns(branch)) for (const id of t.userEntryIds) numberOf.set(id, t.number);
	const map = (old: number) => numberOf.get(userIds[old - 1] ?? "") ?? old;
	const folded = [...decodeRanges(state.folded)].map(map);
	return {
		...state,
		version: 3,
		folded: encodeRanges(folded),
		narrative: state.narrative.replace(/\[T(\d+)\]/g, (_m, n: string) => `[T${map(Number(n))}]`),
	};
}

// ============================================================================
// The tiered summary
// ============================================================================

export interface SummaryInput {
	config: ProtocolConfig;
	branch: PlainEntry[];
	/** Index in `branch` where the kept part starts; everything before it is condensed. */
	cutIndex: number;
	/** True when the cut lies inside a turn (that turn's start is condensed as "in progress"). */
	splitTurn: boolean;
	/** Protocols written during this compaction (backfilled, or the progress of the turn in progress). */
	extraProtocols?: Map<string, ProtocolEntryData>;
	/** Rebuild the state of work from the protocols of all older turns instead of updating it. */
	rebuildState?: boolean;
}

export interface TurnBlock {
	turn: Turn;
	text: string;
	pinned: boolean;
	inProgress: boolean;
	missing: boolean;
}

export interface CompactionPlan {
	condensed: Turn[];
	/** Newest condensed turns (plus pinned ones) shown in detail, oldest first. */
	detail: TurnBlock[];
	/** Condensed turns not shown in detail. */
	older: Turn[];
	/** Older turns whose content is not yet in the state of work. */
	toFold: Turn[];
	/** Pi summaries (or ones from earlier versions) not yet merged into the state of work. */
	foreign: PlainEntry[];
	previous?: FoldState;
	/** Pinned turns that did not fit the detail budget. */
	pinnedDropped: number[];
	missingTurns: number;
}

function protocolLines(f: ProtocolFields): string[] {
	const lines: string[] = [];
	for (const r of f.result) lines.push(`Result: ${r}`);
	for (const d of f.decision) lines.push(`Decision: ${d}`);
	if (f.files.length) lines.push(`Files: ${f.files.join(", ")}`);
	for (const o of f.other) lines.push(`Note: ${o}`);
	return lines;
}

function lastAssistantText(entries: PlainEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i].message;
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = (m.content as Record<string, unknown>[])
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export function renderDetailBlock(
	turn: Turn,
	protocol: ProtocolEntryData | undefined,
	opts: { config: ProtocolConfig; pinned: boolean; inProgress: boolean; entries: PlainEntry[] },
): string {
	const { config, pinned, inProgress, entries } = opts;
	const n = turn.number;
	const lines = [`### Turn ${n}${pinned ? " (pinned, full text)" : ""}${inProgress ? " (in progress)" : ""}`];
	if (pinned) {
		lines.push(
			clipToTokens(serializeTurn(entries, 4000), config.pinnedMaxTokens, `call protocol_turn(${n}) for the rest`),
		);
		return lines.join("\n");
	}
	if (config.keepUserMessages) {
		lines.push(`User: ${turnUserText(entries, config.userMessageMaxChars, `full text via protocol_turn(${n})`)}`);
	}
	if (protocol?.fields) {
		if (inProgress) lines.push("Progress so far (the turn continues after the condensed part):");
		lines.push(...protocolLines(protocol.fields));
		for (const b of branchSummaries(entries))
			lines.push(`Side branch explored and left: ${clip(b.replace(/\s+/g, " "), 1500, `see protocol_turn(${n})`)}`);
		if (config.keepUserMessages) lines.push(...userShellRuns(entries, 1200));
		if (inProgress)
			for (const o of protocol.fields.open.filter((x) => !isNoneItem(x))) lines.push(`Still to do: ${o}`);
	} else {
		const digest = serializeTurn(
			config.keepUserMessages ? entries.filter((e) => !isUserMessage(e)) : entries,
			300,
			1500,
		);
		if (!digest.trim()) {
			lines.push("(no answer recorded: the run was interrupted or failed before any output)");
		} else {
			lines.push(
				inProgress
					? "Steps so far (condensed, tool output shortened; start and end kept):"
					: "No protocol was written for this turn; condensed transcript (start and end kept):",
			);
			lines.push(clipMiddle(digest, config.digestMaxTokens, `middle cut – call protocol_turn(${n})`));
		}
	}
	return lines.join("\n");
}

/** Decides which condensed turns are shown in detail and which go into the state of work. */
export function planCompaction(input: SummaryInput): CompactionPlan {
	const { config, branch, cutIndex } = input;
	const turns = collectTurns(branch);
	const protocols = protocolsWith(branch, input.extraProtocols);
	const pins = collectPins(branch);
	// compaction entries are appended after the turns they keep, so look at the whole branch
	const previous = latestFoldState(branch, branch.length);
	const condensed = turns.filter((t) => t.index < cutIndex);
	const inProgressTurn = input.splitTurn ? condensed[condensed.length - 1] : undefined;

	const block = (turn: Turn, pinned: boolean): TurnBlock => {
		const inProgress = turn === inProgressTurn;
		const entries = inProgress ? turn.entries.filter((e) => branch.indexOf(e) < cutIndex) : turn.entries;
		const p = protocols.get(turn.userEntryId);
		return {
			turn,
			pinned,
			inProgress,
			missing: !p?.fields,
			text: renderDetailBlock(turn, p, { config, pinned, inProgress, entries }),
		};
	};

	// fill the detail budget: the turn in progress, pinned turns (newest first), then the newest turns
	const chosen = new Map<Turn, TurnBlock>();
	let used = 0;
	const tryAdd = (b: TurnBlock): boolean => {
		const t = tok(b.text) + 1;
		if (used + t > config.detailMaxTokens) return false;
		chosen.set(b.turn, b);
		used += t;
		return true;
	};
	if (inProgressTurn) {
		const b = block(inProgressTurn, false);
		if (!tryAdd(b) && config.detailMaxTokens > 200) {
			const clipped = { ...b, text: clipToTokens(b.text, config.detailMaxTokens - used - 1) };
			tryAdd(clipped);
		}
	}
	const pinnedDropped: number[] = [];
	for (const turn of [...condensed].reverse()) {
		if (turn === inProgressTurn || !pins.has(turn.userEntryId)) continue;
		if (!tryAdd(block(turn, true))) pinnedDropped.push(turn.number);
	}
	for (const turn of [...condensed].reverse()) {
		if (chosen.has(turn) || turn === inProgressTurn || pins.has(turn.userEntryId)) continue;
		if (!tryAdd(block(turn, false))) break;
	}

	const detail = condensed.filter((t) => chosen.has(t)).map((t) => chosen.get(t) as TurnBlock);
	const older = condensed.filter((t) => !chosen.has(t));

	// earlier summaries not written by this version
	const consumed = new Set(previous?.foreignConsumed ?? []);
	const foreign = branch.filter(
		(e) => e.type === "compaction" && !isOwnCompaction(e) && !consumed.has(e.id) && (e.summary ?? "").trim(),
	);
	// turns without protocol that such a summary already covers need no raw digest
	const coveredIndex = Math.max(
		-1,
		...branch
			.filter((e) => e.type === "compaction" && !isOwnCompaction(e))
			.map((e) =>
				typeof e.firstKeptEntryId === "string" ? branch.findIndex((x) => x.id === e.firstKeptEntryId) : -1,
			),
	);
	const folded = input.rebuildState ? new Set<number>() : decodeRanges(previous?.folded);
	const toFold = older.filter(
		(t) => !folded.has(t.number) && !(t.index < coveredIndex && !protocols.get(t.userEntryId)?.fields),
	);

	return {
		condensed,
		detail,
		older,
		toFold,
		foreign,
		previous,
		pinnedDropped,
		missingTurns: detail.filter((b) => b.missing).length,
	};
}

/** Compact text of turns for the fold call (protocol lines, or a short digest without protocol). */
export interface FoldChunk {
	text: string;
	turns: number[];
	foreignIds: string[];
}

/** Compact text of turns for the fold calls (protocol lines, or a short digest without protocol), in chunks. */
export function foldInputs(
	plan: CompactionPlan,
	branch: PlainEntry[],
	config: ProtocolConfig,
	extra?: Map<string, ProtocolEntryData>,
): FoldChunk[] {
	const protocols = protocolsWith(branch, extra);
	const chunks: FoldChunk[] = [];
	let current: FoldChunk = { text: "", turns: [], foreignIds: [] };
	let size = 0;
	const push = (text: string, turn?: number, foreignId?: string) => {
		const piece = clipToTokens(text, config.foldChunkTokens);
		const t = tok(piece);
		if (size + t > config.foldChunkTokens && size > 0) {
			chunks.push(current);
			current = { text: "", turns: [], foreignIds: [] };
			size = 0;
		}
		current.text += (current.text ? "\n\n" : "") + piece;
		if (turn !== undefined) current.turns.push(turn);
		if (foreignId !== undefined) current.foreignIds.push(foreignId);
		size += t;
	};
	for (const f of plan.foreign)
		push(`Earlier summary written before the protocol existed:\n${f.summary ?? ""}`, undefined, f.id);
	for (const turn of plan.toFold) {
		const p = protocols.get(turn.userEntryId);
		const user = clip(turnUserText(turn.entries, 300), 600, "shortened");
		const side = branchSummaries(turn.entries).map(
			(b) => `Side branch explored and left: ${clip(b, 800, "shortened")}`,
		);
		const body = p?.fields
			? [...protocolLines(p.fields), ...side].join("\n")
			: `Assistant (no protocol, shortened): ${clip(lastAssistantText(turn.entries), 600, "shortened")}` +
				(toolCallFiles(turn.entries).length ? `\nFiles: ${toolCallFiles(turn.entries).join(", ")}` : "");
		push(`[T${turn.number}] User: ${user}\n${body}`, turn.number);
	}
	if (size > 0) chunks.push(current);
	return chunks;
}

/** One line per older turn that is not in the state of work (used when no model call is possible). */
export function pendingLine(turn: Turn, protocol: ProtocolEntryData | undefined): string {
	const head = protocol?.fields?.result[0] ?? protocol?.fields?.decision[0];
	const text = head ?? `user asked: ${turnUserText(turn.entries)}`;
	return `[T${turn.number}] ${short(text, 160)}`;
}

/**
 * Room for the narrative in tokens: the status budget minus what index, rules, open items and
 * files will take (each at most its own share), but never less than a fifth of the budget.
 */
export function narrativeBudget(
	config: ProtocolConfig,
	parts: { index: string[]; rules: string[]; open: string[]; files: { path: string; turn: number }[] },
): number {
	const budget = config.statusMaxTokens;
	const cost = (lines: string[], share: number) =>
		Math.min(
			Math.floor(budget * share),
			lines.reduce((sum, l) => sum + tok(l) + 1, 0),
		);
	const used =
		cost(parts.index, 0.35) +
		cost(
			parts.rules.map((r) => `- ${r}`),
			0.25,
		) +
		cost(
			parts.open.map((o) => `- ${o}`),
			0.15,
		) +
		cost(
			parts.files.map((f) => `${f.path} [T${f.turn}]`),
			0.05,
		) +
		300; // headings and notes
	return Math.max(Math.floor(budget * 0.2), budget - used);
}

export function shortenPrompt(text: string, maxWords: number): string {
	const words = text.split(/\s+/).filter(Boolean).length;
	return [
		`The following text has ${words} words and must be shortened to at most ${maxWords} words.`,
		"Shorten every topic evenly: keep every heading and every topic, the last topics and the known problems as well. Keep facts, names, numbers, paths and the [T..] references; drop details and explanations first, never add anything. Output only the shortened text.",
		"",
		text,
	].join("\n");
}

export function foldPrompt(previousNarrative: string, turnsText: string, maxWords: number): string {
	return [
		"You keep the STATE OF WORK of a long working session up to date. It replaces older turns that no longer fit into the context.",
		"Below are the current state and the protocols of turns that now leave the detailed log. Rewrite the state so that it also covers these turns.",
		"Newer turns follow in the context separately, so this state is a record of the OLDER part only: write no next steps or plans, they would be outdated.",
		"Organise it by topic (one short heading per topic): the goal, what exists and works, important decisions with their reasons, approaches that were tried and dropped and why, known problems. It is an overview: an index with one line per turn is kept separately, so refer to turns like [T12] instead of repeating every detail.",
		"KEEP EVERY TOPIC of the current state. Shorten its wording if space is needed, but never drop a topic, a decision or a number unless one of the new turns replaced it; then state only the result.",
		"Add the new turns to the matching topics or as new topics.",
		"Put the turn number in brackets after facts a reader may want to look up, like [T12].",
		"Leave out rules from the user, open items and file lists: they are kept separately.",
		"Do not invent anything that is not in the input. Copy names, numbers and paths exactly.",
		`Write at most ${maxWords} words of plain prose or short bullet points. Output only the new state.`,
		"",
		"<current_state>",
		previousNarrative.trim() || "(empty: this is the first part of the session)",
		"</current_state>",
		"<turns>",
		turnsText,
		"</turns>",
	].join("\n");
}

export interface StatusParts {
	rules: string[];
	open: string[];
	files: { path: string; turn: number }[];
	narrative: string;
	/** One line per older turn (already fitted to its budget by buildIndex), oldest first. */
	index?: string[];
	/** Older turns not (yet) in the narrative: one line each, used when the model was unavailable. */
	pendingLines: string[];
	notes: string[];
}

// ============================================================================
// Index of older turns (built from the protocols every time, so it cannot drift)
// ============================================================================

/** One index line: what the turn produced, from its protocol, or what the user asked. */
export function indexLine(turn: Turn, protocol: ProtocolEntryData | undefined, maxChars = 160): string {
	const f = protocol?.fields;
	const own = f?.index?.find((x) => x.trim());
	const parts = own ? [own] : f ? [f.result[0], f.decision[0]].filter((x): x is string => !!x) : [];
	const text = parts.length ? parts.join(" — ") : `user: ${turnUserText(turn.entries)}`;
	return `[T${turn.number}] ${short(text, maxChars)}`;
}

/** The model's search terms of a turn; older protocols without them fall back to the start of their index line. */
export function turnTags(turn: Turn, protocol: ProtocolEntryData | undefined): string[] {
	const f = protocol?.fields;
	const tags = (f?.tags ?? [])
		.flatMap(splitList)
		.map((x) => x.trim().replace(/\.$/, ""))
		.filter(Boolean);
	if (tags.length) return tags;
	const head = f?.index?.[0] ?? f?.result[0] ?? turnUserText(turn.entries);
	const words = head.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
	return words ? [`${words}…`] : [];
}

/** "T3, T5–T7" */
function turnList(numbers: number[]): string {
	const out: string[] = [];
	for (let i = 0; i < numbers.length; i++) {
		let j = i;
		while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
		out.push(j > i ? `T${numbers[i]}–T${numbers[j]}` : `T${numbers[i]}`);
		i = j;
	}
	return out.join(", ");
}

/**
 * A line for a range of turns that no longer fit one by one: the search terms the model gave
 * those turns, each with the turns it belongs to. Terms shared by several turns come first when
 * not all fit; the line lists them in order of first appearance.
 */
export function indexGroupLine(turns: Turn[], protocols: Map<string, ProtocolEntryData>, maxTerms = 12): string {
	const terms = new Map<string, { label: string; turns: number[]; first: number }>();
	let order = 0;
	for (const t of turns)
		for (const tag of turnTags(t, protocols.get(t.userEntryId))) {
			const key = tag.toLowerCase();
			const e = terms.get(key) ?? { label: tag, turns: [], first: order++ };
			if (!e.turns.includes(t.number)) e.turns.push(t.number);
			terms.set(key, e);
		}
	const chosen = [...terms.values()]
		.sort((a, b) => b.turns.length - a.turns.length || a.first - b.first)
		.slice(0, maxTerms)
		.sort((a, b) => a.first - b.first);
	const first = turns[0].number;
	const last = turns[turns.length - 1].number;
	const body = chosen.map((e) => `${e.label} (${turnList(e.turns)})`).join("; ");
	const more = terms.size > chosen.length ? ` (+${terms.size - chosen.length} more terms)` : "";
	return `[T${first}–T${last}] ${body || "(no protocols)"}${more} — protocol_read or protocol_search for details`;
}

/**
 * Index lines for the older turns within a token budget: the newest turns one line each, the
 * oldest grouped into range lines when the budget is short. Oldest first.
 */
export function buildIndex(turns: Turn[], protocols: Map<string, ProtocolEntryData>, budget: number): string[] {
	if (!turns.length || budget <= 0) return [];
	const lines = turns.map((t) => indexLine(t, protocols.get(t.userEntryId)));
	const cost = (ls: string[]) => ls.reduce((sum, l) => sum + tok(l) + 1, 0);
	if (cost(lines) <= budget) return lines;
	// newest single lines first, keeping a share of the budget for the grouped rest
	const groupBudget = Math.floor(budget * 0.3);
	let used = 0;
	let firstSingle = turns.length;
	for (let i = turns.length - 1; i >= 0; i--) {
		const c = tok(lines[i]) + 1;
		if (used + c > budget - groupBudget) break;
		used += c;
		firstSingle = i;
	}
	const rest = turns.slice(0, firstSingle);
	const groupSize = Math.max(10, Math.ceil(rest.length / 8));
	const groups: string[] = [];
	for (let i = 0; i < rest.length; i += groupSize)
		groups.push(indexGroupLine(rest.slice(i, i + groupSize), protocols));
	// groups that still do not fit collapse into one line for the oldest range
	const kept: string[] = [];
	let gUsed = 0;
	for (let i = groups.length - 1; i >= 0; i--) {
		const c = tok(groups[i]) + 1;
		if (gUsed + c > groupBudget) {
			// everything older than the groups that fit becomes one line, still with its main terms;
			// to make room for it, the oldest kept groups join that line
			let upto = (i + 1) * groupSize;
			let line = indexGroupLine(rest.slice(0, upto), protocols);
			while (kept.length && gUsed + tok(line) + 1 > groupBudget) {
				gUsed -= tok(kept.shift() as string) + 1;
				upto = Math.min(rest.length, upto + groupSize);
				line = indexGroupLine(rest.slice(0, upto), protocols);
			}
			kept.unshift(line);
			break;
		}
		kept.unshift(groups[i]);
		gUsed += c;
	}
	return [...kept, ...lines.slice(firstSingle)];
}

/** The status section with its hard limit. Narrative gets what the lists leave. */
export function renderStatus(
	parts: StatusParts,
	config: ProtocolConfig,
	coveredTurns: string,
): { text: string; dropped: string[] } {
	const budget = config.statusMaxTokens;
	const dropped: string[] = [];
	const out: string[] = [];

	const rules = fitList(parts.rules, Math.floor(budget * 0.25), (r) => `- ${r}`);
	out.push("## Active rules from the user");
	out.push(rules.kept.length ? rules.kept.map((r) => `- ${r}`).join("\n") : "- (none recorded)");
	if (rules.dropped) {
		out.push(`- […${rules.dropped} later rules did not fit; search them with protocol_search]`);
		dropped.push(`${rules.dropped} Vorgaben`);
	}

	const open = fitList(parts.open, Math.floor(budget * 0.15), (o) => `- ${o}`);
	out.push("", "## Open items");
	out.push(open.kept.length ? open.kept.map((o) => `- ${o}`).join("\n") : "- (none recorded)");
	if (open.dropped) {
		out.push(`- […${open.dropped} more]`);
		dropped.push(`${open.dropped} offene Punkte`);
	}

	const fileItems = parts.files.map((f) => `${f.path} [T${f.turn}]`);
	const files = fitList(fileItems, Math.floor(budget * 0.05), (f) => f);
	if (files.kept.length) {
		out.push("", "## Files touched (most recent first)");
		out.push(files.kept.join(", ") + (files.dropped ? `, …${files.dropped} older` : ""));
	}
	if (parts.index?.length) {
		out.push(
			"",
			"## Index of older turns (protocol_read returns the full protocol of any turn listed here)",
			...parts.index,
		);
	}

	const head = out.join("\n");
	const left = Math.max(0, budget - tok(head) - 40);
	const stateHead = `## State of work${coveredTurns ? ` (covers turns ${coveredTurns})` : ""}`;
	let narrative = parts.narrative.trim();
	if (parts.pendingLines.length) {
		const room = Math.max(0, left - tok(narrative) - 20);
		const pending = fitList([...parts.pendingLines].reverse(), room, (l) => l);
		const lines = [...pending.kept].reverse();
		const omitted = parts.pendingLines.length - lines.length;
		narrative = [
			narrative,
			"Turns not yet merged into the state above (one line each):",
			...(omitted ? [`[…${omitted} older turns omitted; use protocol_search]`] : []),
			...lines,
		]
			.filter(Boolean)
			.join("\n");
		if (omitted) dropped.push(`${omitted} Zugzeilen`);
	}
	if (tok(narrative) > left) dropped.push("state of work shortened");
	narrative = clipToTokens(
		narrative || "(nothing condensed yet)",
		left,
		"state cut at the size limit; use protocol_search for details",
	);

	const sections = [stateHead, narrative, "", head];
	if (parts.notes.length) {
		const notes = fitList(parts.notes, Math.max(0, budget - tok(sections.join("\n")) - 10), (n) => `- ${n}`);
		if (notes.kept.length) sections.push("", "## Review notes", notes.kept.map((n) => `- ${n}`).join("\n"));
	}
	return { text: sections.join("\n"), dropped };
}

export function renderSummary(status: string, detail: TurnBlock[], config: ProtocolConfig): string {
	const tools = [
		config.searchTool ? "protocol_search finds earlier turns by keywords" : "",
		config.lookupTool ? 'protocol_read returns the full protocols of turns (e.g. "12, 40-44")' : "",
		config.lookupTool ? "protocol_turn returns the original transcript of one turn" : "",
	].filter(Boolean);
	const out = [
		"# Session protocol",
		"Older turns of this session were condensed. The state of work covers the oldest part; the most recent condensed turns follow in detail" +
			(config.keepUserMessages ? " with the user message verbatim" : "") +
			". " +
			(tools.length
				? `Tools: ${tools.join("; ")}. Look things up instead of guessing details that are not stated here.`
				: "Details not stated here are no longer available; ask the user instead of guessing."),
		"",
		status,
		"",
		"## Recent turns in detail",
		detail.length ? detail.map((b) => b.text).join("\n\n") : "(none)",
	];
	return out.join("\n");
}

// ============================================================================
// Consolidation pass (rules and open items only)
// ============================================================================

export function consolidationPrompt(rules: string[], open: string[], context: string): string {
	return [
		"You maintain the protocol of a long working session. Below are the numbered active rules, the numbered open items and recent context.",
		"Decide which entries to KEEP. You cannot rewrite entries, only choose them by number:",
		"- of duplicates and near-duplicates (also the same rule in two languages) keep the most complete one,",
		"- drop open items the context shows as done,",
		"- rules are numbered in the order the user gave them: when a later rule contradicts or replaces an earlier one, drop the earlier one,",
		"- drop rules the user later withdrew,",
		'- drop RULES entries that are not standing instructions about how to work: decisions about the code, findings, plans, one-time tasks that were carried out ("implement X as proposed", "note Y in STATUS.md"), "none".',
		"Otherwise keep the entry; a rule is not dropped just because it is old.",
		"Under NOTES list contradictions or gaps you noticed (or write none).",
		"Answer in exactly this form and nothing else (numbers separated by commas, ranges like R3-R5 allowed, 'none' for an empty list):",
		"RULES: R1, R4, ...",
		"OPEN: O2, ...",
		"NOTES:",
		"- …",
		"",
		"<rules>",
		rules.map((r, i) => `R${i + 1}: ${r}`).join("\n") || "(none)",
		"</rules>",
		"<open>",
		open.map((o, i) => `O${i + 1}: ${o}`).join("\n") || "(none)",
		"</open>",
		"<context>",
		context,
		"</context>",
	].join("\n");
}

/** "R1, R3-R5, 7" -> the chosen indices (0-based) within 0..count-1; undefined when nothing is readable. */
function parseSelection(text: string, prefix: string, count: number): number[] | undefined {
	const t = text.trim();
	if (/^(none|nothing|keine|-)\.?$/i.test(t)) return [];
	const out = new Set<number>();
	const re = new RegExp(`${prefix}?\\s*(\\d+)(?:\\s*[-–]\\s*${prefix}?\\s*(\\d+))?`, "gi");
	for (let m = re.exec(t); m; m = re.exec(t)) {
		const a = Number(m[1]);
		const b = m[2] ? Number(m[2]) : a;
		for (let n = Math.min(a, b); n <= Math.max(a, b) && n - a < 1000; n++) if (n >= 1 && n <= count) out.add(n - 1);
	}
	return out.size ? [...out].sort((x, y) => x - y) : undefined;
}

/**
 * Reads the review answer. The model only chooses entries by number, so nothing can be invented or
 * reworded; entries keep their original wording and order. Undefined when the answer is unusable
 * (wrong form, or no rule kept at all although there were some).
 */
export function parseConsolidation(
	text: string,
	rules: string[],
	open: string[],
): { rules: string[]; open: string[]; notes: string[] } | undefined {
	const ruleLine = /^\s*RULES\s*:\s*(.*)$/im.exec(text);
	const openLine = /^\s*OPEN\s*:\s*(.*)$/im.exec(text);
	if (!ruleLine || !openLine) return undefined;
	const keepRules = parseSelection(ruleLine[1], "R", rules.length);
	const keepOpen = parseSelection(openLine[1], "O", open.length);
	if (!keepRules || !keepOpen) return undefined;
	if (rules.length && !keepRules.length) return undefined; // dropping every rule is never plausible
	const notes: string[] = [];
	const notesAt = text.search(/^\s*NOTES\s*:/im);
	if (notesAt >= 0) {
		for (const raw of text.slice(notesAt).split(/\r?\n/).slice(1)) {
			const item = raw
				.trim()
				.replace(/^[-*•]\s*/, "")
				.trim();
			if (item && !isNoneItem(item)) notes.push(item);
		}
	}
	return { rules: keepRules.map((i) => rules[i]), open: keepOpen.map((i) => open[i]), notes };
}

/**
 * Guards against the review inventing content: every reviewed rule must share most of its
 * words with some input rule (same for open items). Otherwise the review is discarded.
 */
/**
 * True when every reviewed item is made of the input: most of its words occur in the input as a
 * whole (merged duplicates combine words of several items) and a good part in one single item.
 */
export function reviewIsSubset(input: string[], reviewed: string[]): boolean {
	const inWords = input.map((s) => new Set(norm(s).split(" ").filter(Boolean)));
	const all = new Set(inWords.flatMap((set) => [...set]));
	return reviewed.every((r) => {
		const words = norm(r).split(" ").filter(Boolean);
		if (!words.length) return true;
		const share = (set: Set<string>) => words.filter((w) => set.has(w)).length / words.length;
		return share(all) >= 0.7 && inWords.some((set) => share(set) >= 0.4);
	});
}

// ============================================================================
// Search
// ============================================================================

export interface SearchHit {
	turn: number;
	score: number;
	text: string;
}

function snippet(text: string, words: string[], width = 220): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const w of words) {
		const i = lower.indexOf(w);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	if (at < 0) return short(text, width);
	const start = Math.max(0, at - Math.floor(width / 3));
	const piece = text.slice(start, start + width).replace(/\s+/g, " ");
	return `${start > 0 ? "…" : ""}${piece}${start + width < text.length ? "…" : ""}`;
}

/** Ranks turns by how many distinct query words occur in user message, protocol and final answer. */
export function searchTurns(branch: PlainEntry[], query: string, max: number): SearchHit[] {
	const words = [
		...new Set(
			norm(query)
				.split(" ")
				.filter((w) => w.length >= 2),
		),
	];
	if (!words.length) return [];
	const phrase = norm(query);
	const protocols = collectProtocols(branch);
	const hits: SearchHit[] = [];
	for (const turn of collectTurns(branch)) {
		const user = turnUserText(turn.entries);
		const p = protocols.get(turn.userEntryId);
		const proto = p?.fields
			? protocolLines(p.fields)
					.concat(
						p.fields.open.map((o) => `Open: ${o}`),
						p.fields.rule.map((r) => `Rule: ${r}`),
						(p.fields.index ?? []).map((x) => `Index: ${x}`),
						(p.fields.tags ?? []).map((x) => `Tags: ${x}`),
					)
					.join("\n")
			: "";
		const answer = lastAssistantText(turn.entries);
		const hay = norm(`${user} ${proto} ${answer}`);
		let score = words.filter((w) => hay.includes(w)).length;
		if (!score) continue;
		if (words.length > 1 && hay.includes(phrase)) score += words.length;
		// the model chose these terms for exactly this purpose
		const tagHay = norm((p?.fields?.tags ?? []).join(" "));
		if (tagHay) score += words.filter((w) => tagHay.includes(w)).length;
		const head = p?.fields?.index?.[0] ?? p?.fields?.result[0] ?? p?.fields?.decision[0] ?? short(answer, 160);
		const lines = [`Turn ${turn.number} (${Math.min(score, words.length)}/${words.length} words): ${head}`];
		const inUser = words.some((w) => user.toLowerCase().includes(w));
		lines.push(`  user: ${snippet(user, words)}`);
		if (!inUser && answer) lines.push(`  answer: ${snippet(answer, words)}`);
		hits.push({ turn: turn.number, score, text: lines.join("\n") });
	}
	return hits.sort((a, b) => b.score - a.score || b.turn - a.turn).slice(0, Math.max(1, max));
}

// ============================================================================
// Diagnostic appendix of /protokoll export (for troubleshooting, never sent to the model)
// ============================================================================

function cell(text: string, n: number): string {
	return short(text.replace(/\s+/g, " ").replace(/\|/g, "/"), n);
}

/** Everything stored by the extension for this branch, in readable form. */
export function diagnosticAppendix(branch: PlainEntry[], config: ProtocolConfig, rebuildPending: boolean): string {
	const turns = collectTurns(branch);
	const protocols = collectProtocols(branch);
	const starts = turnStarts(branch);
	const turnOfEntry = new Map<string, number>();
	for (const t of turns) for (const e of t.entries) if (e.id) turnOfEntry.set(e.id, t.number);
	const supplemented = new Set<string>();
	for (const e of branch)
		if (e.type === "custom" && e.customType === SUPPLEMENT_ENTRY && e.data && typeof e.data === "object") {
			const id = (e.data as SupplementEntryData).userEntryId;
			supplemented.add(starts.get(id) ?? id);
		}
	const out: string[] = [
		"",
		"---",
		"",
		"# Diagnostics",
		"Everything the extension stored for this branch. This part is never shown to the model.",
		"",
		"## Effective configuration",
		"```json",
		JSON.stringify(config, null, 2),
		"```",
		"",
		"## Compactings",
		"| # | by | took | tokens before | summary ≈ tokens | first kept turn | detail turns | folded | time |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	let n = 0;
	/** the pass this extension measured last, matched to the compaction entry it produced */
	let lastCompact: CompactEntryData | undefined;
	for (const e of branch) {
		if (e.type === "custom" && e.customType === COMPACT_ENTRY && e.data && typeof e.data === "object") {
			lastCompact = e.data as CompactEntryData;
			continue;
		}
		if (e.type !== "compaction") continue;
		n++;
		const own = isOwnCompaction(e);
		const d = (e.details ?? {}) as { status?: FoldState; detailTurns?: number };
		const kept = turnOfEntry.get(String(e.firstKeptEntryId ?? ""));
		const took = lastCompact ? compactDuration(lastCompact.durationMs) : "";
		lastCompact = undefined;
		out.push(
			`| ${n} | ${own ? "protokoll" : "Pi"} | ${took} | ${e.tokensBefore ?? "?"} | ${tok(String(e.summary ?? ""))} | ${kept ? `T${kept}` : "?"} | ${d.detailTurns ?? ""} | ${d.status?.folded ?? ""} | ${e.timestamp ?? ""} |`,
		);
	}
	if (!n) out.push("| – | none | | | | | | | |");
	const state = latestFoldState(branch, branch.length);
	out.push("", "## Stored state of the last own compaction");
	out.push(`Rebuild requested for the next compaction: ${rebuildPending ? "yes" : "no"}`);
	if (!state) out.push("(none)");
	else {
		out.push(
			`Folded turns: ${state.folded || "(none)"}`,
			`Rules reviewed up to turn: ${state.rulesThrough ?? "(never)"}`,
			`Pi summaries merged: ${state.foreignConsumed.length}`,
			"",
			"### Reviewed rules",
			...(state.rules?.length ? state.rules.map((r, i) => `R${i + 1}. ${r}`) : ["(none stored)"]),
			"",
			"### State of work (as stored)",
			state.narrative || "(empty)",
		);
	}
	out.push(
		"",
		"## Turns",
		"| turn | protocol | index/tags | end | answers | tool calls | user |",
		"|---|---|---|---|---|---|---|",
	);
	for (const t of turns) {
		const p = protocols.get(t.userEntryId);
		const assistants = t.entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		const tools = assistants.reduce(
			(sum, e) =>
				sum +
				(Array.isArray(e.message?.content)
					? (e.message.content as { type?: string }[]).filter((b) => b?.type === "toolCall").length
					: 0),
			0,
		);
		const stop = assistants.at(-1)?.message?.stopReason ?? "–";
		const hasOwn = /^\s*[-*•]?\s*(index|tags)\s*:/im.test(p?.raw ?? "");
		const idx = p?.fields?.index?.length
			? hasOwn
				? "own"
				: supplemented.has(t.userEntryId)
					? "added later"
					: "?"
			: "–";
		const steer = t.userEntryIds.length > 1 ? ` (+${t.userEntryIds.length - 1} sent while working)` : "";
		out.push(
			`| ${t.number} | ${p ? (p.fields ? p.source : `${p.source}, empty`) : "none"} | ${idx} | ${stop} | ${assistants.length} | ${tools} | ${cell(turnUserText(t.entries), 80)}${steer} |`,
		);
	}
	const errors = turns.flatMap((t) =>
		t.entries
			.filter((e) => e.message?.role === "assistant" && (e.message.stopReason === "error" || e.message.errorMessage))
			.map(
				(e) =>
					`- T${t.number} (${e.message?.stopReason}): ${cell(String(e.message?.errorMessage ?? "(no message)"), 300)}`,
			),
	);
	out.push("", "## Provider error messages", ...(errors.length ? errors : ["(none)"]));
	out.push("", "## All protocols in full");
	for (const t of turns) {
		const f = protocols.get(t.userEntryId)?.fields;
		if (!f) continue;
		out.push("", `### T${t.number} (${protocols.get(t.userEntryId)?.source})`);
		out.push(`User: ${clip(turnUserText(t.entries), 600, "shortened")}`);
		const add = (key: string, values: string[] | undefined) => {
			for (const v of values ?? []) out.push(`${key}: ${v}`);
		};
		add("result", f.result);
		add("decision", f.decision);
		add("files", f.files);
		add("open", f.open);
		add("rule", f.rule);
		add("revoke", f.revoke);
		add("index", f.index);
		add("tags", f.tags);
		add("note", f.other);
	}
	return out.join("\n");
}
