/**
 * protokoll – a running per-turn protocol instead of summarising the whole history at compaction time.
 *
 * - The system prompt asks the model to end every final answer with a <protocol> block.
 * - The block is cut out of the answer and stored as a session entry (shown collapsed).
 * - A final answer without a block triggers one follow-up request with the unchanged context
 *   plus a short instruction, so a prompt cache (e.g. Strata) only has to read the new tokens.
 * - On compaction the summary has three tiers with hard limits:
 *   1. the latest turns stay in full (keepRecentTurns, at most keepRecentPercent of the window);
 *   2. the newest condensed turns: user message verbatim + protocol (detailMaxTokens);
 *   3. everything older as a status (statusMaxTokens): rules, open items and files built from the
 *      protocols without a model, plus a "state of work" the model updates incrementally with the
 *      protocols of turns leaving tier 2. It is stored in the compaction entry and never redone.
 * - Tools: protocol_search finds earlier turns by keywords, protocol_turn returns one in full.
 * - A turn that stopped early (aborted, error, output limit) gets its protocol when the session
 *   continues: the request repeats the last context plus a short instruction, so a prompt cache only
 *   reads the new tokens. Compaction backfills whatever is still missing and shows its progress.
 *
 * Configuration: <agent-dir>/protokoll.json, overridden by <project>/.pi/protokoll.json.
 * Commands: /protokoll [status|show|export [file]|pin N|unpin N|on|off|reload|rebuild|repair]
 */

import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	activeRules,
	backfillPrompt,
	buildIndex,
	COMPACT_ENTRY,
	type CompactCounts,
	type CompactEntryData,
	type CompactionPlan,
	type CompactStepData,
	type CutChoice,
	chooseCut,
	clip,
	clipMiddle,
	clipToTokens,
	collectPins,
	collectProtocols,
	collectTurns,
	compactDuration,
	compactStatusLine,
	consolidationPrompt,
	contentText,
	currentOpenItems,
	DEFAULT_CONFIG,
	decodeRanges,
	diagnosticAppendix,
	encodeRanges,
	extractBlock,
	FOLLOW_UP_PROMPT,
	type FoldState,
	foldInputs,
	foldPrompt,
	hasProtocolKeys,
	hideBlocks,
	INTERRUPTED_PROMPT,
	isNoneItem,
	isUnsupportedModelCall,
	latestFoldState,
	loadConfig,
	narrativeBudget,
	PIN_ENTRY,
	type PinEntryData,
	type PlainEntry,
	PROGRESS_CHANNEL,
	PROGRESS_PROMPT,
	PROTOCOL_ENTRY,
	type ProgressEvent,
	type ProgressStep,
	type ProtocolConfig,
	type ProtocolEntryData,
	type ProtocolFields,
	parseBlock,
	parseConsolidation,
	parseModelRef,
	parseSupplement,
	planCompaction,
	protocolsWith,
	REBUILD_ENTRY,
	rebuildRequested,
	renderStatus,
	renderSummary,
	STATE_ENTRY,
	type StateEntryData,
	SUPPLEMENT_ENTRY,
	type SupplementEntryData,
	searchTurns,
	serializeTurn,
	sessionEnabled,
	shortenPrompt,
	supplementPrompt,
	systemPromptSection,
	type Turn,
	tok,
	touchedFiles,
	turnHasWork,
	turnUserText,
} from "./core.ts";

const SECTION_KEY = "session_protocol";
const TOOL_NAME = "protocol_turn";
const SEARCH_TOOL = "protocol_search";
const READ_TOOL = "protocol_read";
/** Fixed text of the summary around the tiers (header, section titles). */
const SUMMARY_OVERHEAD = 400;
const STATUS_KEY = "protokoll";
/** Widget with the result of the last compaction; Pi redraws the chat after a compaction, which removes notifications. */
const RESULT_KEY = "protokoll-result";

/** Pi cuts widgets after this many lines. */
const MAX_WIDGET_LINES = 10;

type StepState = "wait" | "run" | "ok" | "fail";
interface Step {
	label: string;
	state: StepState;
	note?: string;
	started?: number;
	ended?: number;
	/** Characters received so far (thinking and text). */
	chars: number;
	thinking: boolean;
}

/**
 * Progress lines above the editor while the extension waits for the model (compaction,
 * backfill, follow-up). Refreshed every second so prefill time is visible too.
 */
export class Progress {
	private steps: Step[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly began = Date.now();
	private readonly ctx: ExtensionContext;
	private readonly title: string;
	/** live line for other extensions (pi-webapp shows it in the browser); nothing is persisted */
	private readonly report?: (line: ProgressStep) => void;
	private closed = false;
	constructor(ctx: ExtensionContext, title: string, report?: (line: ProgressStep) => void) {
		this.ctx = ctx;
		this.title = title;
		this.report = report;
	}

	private get visible(): boolean {
		return this.ctx.hasUI && typeof this.ctx.ui.setWidget === "function";
	}

	add(label: string): Step {
		const step: Step = { label, state: "wait", chars: 0, thinking: false };
		this.steps.push(step);
		this.render();
		return step;
	}

	find(label: string): Step | undefined {
		return this.steps.find((s) => s.label === label && s.state === "wait");
	}

	start(step: Step): void {
		step.state = "run";
		step.started = Date.now();
		step.chars = 0;
		if (!this.timer && (this.visible || this.report)) {
			this.timer = setInterval(() => this.render(), 1000);
			this.timer.unref?.();
		}
		this.render();
	}

	update(step: Step, chars: number, thinking: boolean): void {
		const changed = Math.floor(chars / 200) !== Math.floor(step.chars / 200) || thinking !== step.thinking;
		step.chars = chars;
		step.thinking = thinking;
		if (changed) this.render();
	}

	finish(step: Step, ok: boolean, note?: string): void {
		step.state = ok ? "ok" : "fail";
		step.note = note;
		step.ended = Date.now();
		this.render();
	}

	/** Steps that never ran (aborted run) are marked as skipped. */
	skipRest(): void {
		for (const s of this.steps) if (s.state === "wait") s.note = "skipped";
		this.render();
	}

	/** The run in plain data for the session entry: every step with its own wall time. */
	summary(): CompactStepData[] {
		return this.steps.map((s) => ({
			label: s.label,
			state: s.state === "wait" ? "skipped" : s.state === "run" ? "fail" : s.state,
			ms: Math.max(0, (s.ended ?? s.started ?? this.began) - (s.started ?? this.began)),
			...(s.note ? { note: s.note } : s.state === "run" ? { note: "interrupted" } : {}),
		}));
	}

	/** Wall time of the whole run so far. */
	elapsed(): number {
		return Math.max(0, Date.now() - this.began);
	}

	close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.visible) this.ctx.ui.setWidget(STATUS_KEY, undefined);
		if (!this.closed) {
			this.closed = true;
			this.publish();
		}
	}

	lines(): string[] {
		const secs = (a: number, b: number) => `${Math.max(0, Math.round((b - a) / 1000))} s`;
		const now = Date.now();
		const done = this.steps.filter((s) => s.state === "ok" || s.state === "fail").length;
		const out = [
			`${this.title} · step ${Math.min(done + 1, this.steps.length)}/${this.steps.length} · ${secs(this.began, now)}`,
		];
		// Pi shows at most 10 widget lines: long runs show the steps around the current one
		const room = MAX_WIDGET_LINES - 1;
		let shown = this.steps;
		let before: Step[] = [];
		let after: Step[] = [];
		if (this.steps.length > room) {
			const span = room - 2;
			const cur = this.steps.findIndex((s) => s.state === "wait" || s.state === "run");
			const at = cur < 0 ? this.steps.length : cur;
			const start = Math.max(0, Math.min(at - 2, this.steps.length - span));
			before = this.steps.slice(0, start);
			shown = this.steps.slice(start, start + span);
			after = this.steps.slice(start + span);
		}
		if (before.length) {
			const failed = before.filter((s) => s.state === "fail").length;
			out.push(`  ✓ ${before.length} done${failed ? `, ${failed} of them failed` : ""}`);
		}
		for (const s of shown) {
			if (s.state === "wait") out.push(`  · ${s.label}${s.note ? ` (${s.note})` : ""}`);
			else if (s.state === "run") {
				const phase =
					s.chars === 0
						? "reading context"
						: `${s.thinking ? "thinking" : "writing"} ≈ ${Math.round(s.chars / 3.5)} tokens`;
				out.push(`  ▸ ${s.label} · ${phase} · ${secs(s.started ?? now, now)}`);
			} else {
				const mark = s.state === "ok" ? "✓" : "✗";
				out.push(`  ${mark} ${s.label}${s.note ? ` – ${s.note}` : ""} · ${secs(s.started ?? now, s.ended ?? now)}`);
			}
		}
		if (after.length) out.push(`  · ${after.length} more`);
		return out;
	}

	render(): void {
		if (this.visible) this.ctx.ui.setWidget(STATUS_KEY, this.lines());
		this.publish();
	}

	/** Current step as plain data for the shared bus. Runs without a console UI too. */
	private publish(): void {
		if (!this.report) return;
		const done = this.steps.filter((s) => s.state === "ok" || s.state === "fail").length;
		const current = this.steps.find((s) => s.state === "run") ?? this.steps.find((s) => s.state === "wait");
		const now = Date.now();
		this.report({
			version: 1,
			session: this.ctx.sessionManager.getSessionId(),
			title: this.title,
			step: Math.min(done + 1, this.steps.length),
			steps: this.steps.length,
			label: current?.label ?? "",
			state: current?.state ?? (this.steps.length > 0 && done >= this.steps.length ? "ok" : "wait"),
			ms: this.elapsed(),
			// every step as the console shows it: state, own time, what the model has sent so far
			lines: this.steps.map((s) => ({
				label: s.label,
				state: s.state,
				ms:
					s.started === undefined && s.ended === undefined
						? null
						: Math.max(0, (s.ended ?? now) - (s.started ?? this.began)),
				chars: s.chars,
				thinking: s.thinking,
				...(s.note ? { note: s.note } : {}),
			})),
			closed: this.closed,
		});
	}
}

interface ModelReply {
	text?: string;
	error?: string;
	/** True when the answer hit the output limit (a block in it may be cut off). */
	truncated?: boolean;
	/** True when the model called a tool instead of (or besides) writing text. */
	toolCall?: boolean;
	/** The whole assistant message (to continue the exchange after a misplaced tool call). */
	message?: { content?: unknown };
	/** True when the provider cannot serve this kind of request at all (Cursor), so the caller must not retry another way. */
	unsupportedProvider?: boolean;
}

/** Why a reply carried no usable block, in words for the user. */
function failureReason(reply: ModelReply, signal?: AbortSignal): string {
	if (reply.error !== undefined) {
		const timeout = signal?.aborted && String(signal.reason ?? "").includes("Timeout");
		return timeout ? "time limit reached (followUpTimeoutMs)" : `error: ${reply.error}`;
	}
	if (reply.truncated) return "output limit reached, thinking counts against it (raise followUpMaxTokens)";
	if (reply.toolCall && !reply.text) return "the model called a tool instead of writing the block";
	return "the answer contained no block";
}

/** Why this extension cannot make one of its own model requests right now. */
type BlockedModel = "no-model" | "cursor" | "aux-cursor" | "aux-malformed" | "aux-missing";

/** Notices already shown: one per session and cause, so a blocked provider stays quiet. */
const shownNotices = new Set<string>();

function warnOnce(ctx: ExtensionContext, cause: string, text: string): void {
	const key = `${ctx.sessionManager.getSessionId()}|${cause}`;
	if (shownNotices.has(key)) return;
	shownNotices.add(key);
	ctx.ui.notify(text, "warning");
}

/** One understandable sentence about a blocked request, with the way out. */
function blockedNotice(blocked: BlockedModel, reference: string): string {
	if (blocked === "cursor")
		return 'protokoll: automatic model requests are unavailable with Cursor. Set "auxiliaryModel" in protokoll.json to use a different model for protocol generation.';
	if (blocked === "aux-cursor")
		return `protokoll: the auxiliary model "${reference}" is a Cursor model, which cannot serve these requests either. Choose a different "auxiliaryModel" in protokoll.json.`;
	if (blocked === "aux-malformed")
		return `protokoll: auxiliaryModel "${reference}" is not "provider/model" – protocol requests are skipped.`;
	return `protokoll: auxiliaryModel "${reference}" is not a known model – protocol requests are skipped, the session model is not used instead.`;
}

/**
 * Which model this extension's own requests (follow-up, backfill, state review, repair) go to:
 * `auxiliaryModel` when configured, otherwise the model of the session. The model of the normal chat
 * is never touched. A Cursor model is reported instead of called: the direct request has no session
 * mapping there, and the raw provider exception would otherwise return on every turn.
 */
export function resolveProtocolModel(
	ctx: ExtensionContext,
	reference: string,
): { model?: NonNullable<ExtensionContext["model"]>; blocked?: BlockedModel } {
	if (reference) {
		const ref = parseModelRef(reference);
		if (!ref) return { blocked: "aux-malformed" };
		const found = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!found) return { blocked: "aux-missing" };
		if (isUnsupportedModelCall(found)) return { blocked: "aux-cursor" };
		return { model: found as NonNullable<ExtensionContext["model"]> };
	}
	const model = ctx.model;
	if (!model) return { blocked: "no-model" };
	if (isUnsupportedModelCall(model)) return { blocked: "cursor" };
	return { model };
}

/** The same, plus the one-time notice for the user. Guards and requests both call this. */
export function protocolModel(ctx: ExtensionContext, reference: string) {
	const choice = resolveProtocolModel(ctx, reference);
	if (choice.blocked && choice.blocked !== "no-model")
		warnOnce(ctx, `${choice.blocked}|${reference}`, blockedNotice(choice.blocked, reference));
	return choice;
}

/** One request; streams when the provider allows it, so the progress shows tokens as they come. */
async function callModel(
	ctx: ExtensionContext,
	config: Pick<ProtocolConfig, "auxiliaryModel">,
	context: { messages: unknown[] },
	options: Record<string, unknown>,
	progress?: { bar: Progress; step: Step },
): Promise<ModelReply> {
	const choice = protocolModel(ctx, config.auxiliaryModel);
	const model = choice.model;
	if (!model) {
		const blocked = choice.blocked === "cursor" || choice.blocked === "aux-cursor";
		return {
			error: blocked
				? "the provider cannot serve these requests (Cursor)"
				: `no usable model for protocol requests (${choice.blocked})`,
			unsupportedProvider: blocked,
		};
	}
	try {
		const stream = ctx.modelRegistry.streamSimple(model, context as never, options as never) as unknown as {
			result(): Promise<{ content?: unknown; stopReason?: string; errorMessage?: string }>;
			[Symbol.asyncIterator]?: () => AsyncIterator<{ type: string; delta?: string }>;
		};
		if (progress && typeof stream[Symbol.asyncIterator] === "function") {
			let chars = 0;
			for await (const ev of stream as unknown as AsyncIterable<{ type: string; delta?: string }>) {
				if (typeof ev.delta === "string" && ev.type.endsWith("_delta")) {
					chars += ev.delta.length;
					progress.bar.update(progress.step, chars, ev.type === "thinking_delta");
				}
			}
		}
		const response = await stream.result();
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return { error: response.errorMessage ?? response.stopReason };
		}
		const toolCall =
			Array.isArray(response.content) &&
			(response.content as { type?: string }[]).some((b) => b?.type === "toolCall");
		return {
			text: contentText(response.content).trim(),
			truncated: response.stopReason === "length",
			toolCall,
			message: response,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** 213621 -> "213,621" (thousands separator independent of the system locale). */
function fmt(n: number): string {
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Writes the thinking level into an OpenAI-compatible request body; other APIs stay untouched. */
export function forceThinkingLevel(payload: unknown, model: { api?: string }, level: string): unknown {
	if (model.api !== "openai-completions" || !payload || typeof payload !== "object") return undefined;
	const body = { ...(payload as Record<string, unknown>) };
	if (level === "off") {
		body.reasoning_effort = "none";
		const kwargs = body.chat_template_kwargs;
		body.chat_template_kwargs = {
			...(kwargs && typeof kwargs === "object" ? (kwargs as Record<string, unknown>) : {}),
			enable_thinking: false,
		};
	} else {
		body.reasoning_effort = level;
	}
	return body;
}

export default function protokoll(pi: ExtensionAPI) {
	let config: ProtocolConfig = { ...DEFAULT_CONFIG };
	let enabled = config.enabled;
	/** Block found in an answer of the current run, waiting for the end of the run. */
	let pending = new Map<string, { fields: ProtocolFields; raw: string }>();
	/** Reason of the last failed backfill, shown to the user. */
	let lastFailure = "";
	/** Messages of the running compaction, shown again after Pi has redrawn the chat. */
	let compactNotes: string[] = [];

	/** A notification during compaction: shown now and kept for the result widget. */
	const compactNote = (ctx: ExtensionContext, text: string, level: "info" | "warning") => {
		const plain = text.replace(/^protokoll:\s*/, "");
		compactNotes.push(level === "warning" ? `⚠ ${plain}` : plain);
		ctx.ui.notify(text, level);
	};

	const showResult = (ctx: ExtensionContext, lines: string[] | undefined) => {
		if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
		const fitted =
			lines && lines.length > MAX_WIDGET_LINES
				? [...lines.slice(0, MAX_WIDGET_LINES - 1), `  … ${lines.length - MAX_WIDGET_LINES + 1} more lines`]
				: lines;
		ctx.ui.setWidget(RESULT_KEY, fitted);
	};

	const plainBranch = (ctx: ExtensionContext): PlainEntry[] =>
		ctx.sessionManager.getBranch() as unknown as PlainEntry[];

	const entryTokens = (e: PlainEntry): number => {
		if (e.type === "message" && e.message) return estimateTokens(e.message as never);
		if (e.type === "custom_message") return Math.ceil(contentText((e as { content?: unknown }).content).length / 4);
		return 0;
	};

	const reload = (ctx: ExtensionContext) => {
		const loaded = loadConfig(getAgentDir(), ctx.cwd);
		config = loaded.config;
		for (const w of loaded.warnings) ctx.ui.notify(`protokoll: ${w}`, "warning");
		enabled = sessionEnabled(plainBranch(ctx), config.enabled);
		syncTool();
	};

	/** The tools are declared to the model only while the protocol is on. */
	const syncTool = () => {
		const want = new Map([
			[TOOL_NAME, enabled && config.lookupTool],
			[READ_TOOL, enabled && config.lookupTool],
			[SEARCH_TOOL, enabled && config.searchTool],
		]);
		const active = pi.getActiveTools();
		let next = active.filter((t) => want.get(t) !== false);
		for (const [name, on] of want) if (on && !next.includes(name)) next = [...next, name];
		if (next.length !== active.length || next.some((t, i) => t !== active[i])) pi.setActiveTools(next);
	};

	// ------------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		pending = new Map();
		reload(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		pending = new Map();
		// /tree can move to a branch where /protokoll on|off was set differently
		const onBranch = sessionEnabled(plainBranch(ctx), config.enabled);
		if (onBranch !== enabled) {
			enabled = onBranch;
			syncTool();
		}
		showResult(ctx, undefined);
		if (enabled && config.backfill) await backfillOnContinue(ctx);
		if (enabled) event.systemPromptOptions.sections[SECTION_KEY] = systemPromptSection(config);
		else delete event.systemPromptOptions.sections[SECTION_KEY];
	});

	/** The previous turn stopped early and has no protocol: ask for it before the new prompt goes out. */
	async function backfillOnContinue(ctx: ExtensionContext) {
		const branch = plainBranch(ctx);
		const turns = collectTurns(branch);
		const last = turns[turns.length - 1];
		if (!last || !turnHasWork(last) || collectProtocols(branch).has(last.userEntryId)) return;
		const bar = new Progress(ctx, "protokoll");
		const step = bar.add(`turn ${last.number} was interrupted – writing its protocol`);
		try {
			let data = await backfillByPrefix(
				ctx,
				last,
				INTERRUPTED_PROMPT(config.tag),
				AbortSignal.timeout(config.followUpTimeoutMs),
				{ bar, step },
			);
			const first = data ? "" : lastFailure;
			if (!data) {
				// second chance without the chat context: no tools to call, thinking off, bounded input
				step.label = `turn ${last.number}: protocol from the transcript (${first})`;
				data = await backfillByTranscript(ctx, last, AbortSignal.timeout(config.followUpTimeoutMs), { bar, step });
			}
			if (data) {
				pi.appendEntry<ProtocolEntryData>(PROTOCOL_ENTRY, data);
				bar.finish(step, true);
			} else {
				// marked so that the next prompt does not ask again; compaction retries from the transcript
				pi.appendEntry<ProtocolEntryData>(PROTOCOL_ENTRY, {
					version: 1,
					userEntryId: last.userEntryId,
					turn: last.number,
					source: "missing",
				});
				bar.finish(step, false, "no block – retried at the next compaction");
				ctx.ui.notify(
					`protokoll: turn ${last.number} has no protocol (${first}; transcript: ${lastFailure}) – next attempt at compaction`,
					"warning",
				);
			}
		} finally {
			bar.close();
		}
	}

	/**
	 * Protocol for the LAST turn of the branch: the current context plus one instruction. The request
	 * starts with exactly what the model saw last, so a prompt cache only has to read the new tokens.
	 */
	async function backfillByPrefix(
		ctx: ExtensionContext,
		turn: Turn,
		instruction: string,
		signal: AbortSignal | undefined,
		progress?: { bar: Progress; step: Step },
	): Promise<ProtocolEntryData | undefined> {
		if (progress) progress.bar.start(progress.step);
		let messages: unknown[];
		try {
			messages = [
				...convertToLlm(ctx.sessionManager.buildSessionProjection().messages),
				{ role: "user" as const, content: instruction, timestamp: Date.now() },
			];
		} catch {
			return undefined;
		}
		const reply = await askWithChatContext(ctx, messages, signal, progress);
		const entry = reply.text && !reply.truncated ? toEntry(turn, reply.text) : undefined;
		if (!entry) lastFailure = failureReason(reply, signal);
		return entry;
	}

	/** Protocol for an earlier turn from its transcript (no conversation context needed). */
	async function backfillByTranscript(
		ctx: ExtensionContext,
		turn: Turn,
		signal: AbortSignal | undefined,
		progress?: { bar: Progress; step: Step },
	): Promise<ProtocolEntryData | undefined> {
		if (progress) progress.bar.start(progress.step);
		const transcript = clipMiddle(
			serializeTurn(turn.entries, 1500, 6000),
			config.backfillTranscriptTokens,
			`middle of the turn left out`,
		);
		const reply = await callModel(
			ctx,
			config,
			{
				messages: [
					{ role: "user", content: backfillPrompt(config, turn.number, transcript), timestamp: Date.now() },
				],
			},
			{ maxTokens: config.backfillMaxTokens, ...(signal ? { signal } : {}), ...reasoningOption() },
			progress,
		);
		const entry = reply.text && !reply.truncated ? toEntry(turn, reply.text) : undefined;
		if (!entry) lastFailure = failureReason(reply, signal);
		return entry;
	}

	/** How often a misplaced tool call is answered with "no tools now" before giving up. */
	const TOOL_REDIRECTS = 2;

	/**
	 * A request that repeats the chat context. The tools stay declared (removing them would change
	 * the prompt prefix and miss the cache), so the model may call one out of habit. Such a call is
	 * not executed: it is answered with a tool result saying that tools are unavailable right now,
	 * and the model is asked again. The prefix stays identical, only the new messages are read.
	 */
	async function askWithChatContext(
		ctx: ExtensionContext,
		messages: unknown[],
		signal: AbortSignal | undefined,
		progress?: { bar: Progress; step: Step },
	): Promise<ModelReply> {
		let current = messages;
		for (let attempt = 0; ; attempt++) {
			const reply = await callModel(
				ctx,
				config,
				{ messages: current },
				{ maxTokens: config.followUpMaxTokens, ...(signal ? { signal } : {}), ...chatReasoningOption() },
				progress,
			);
			const body = reply.text ? extractBlock(reply.text, config.tag).body : undefined;
			const hasBlock = body !== undefined && hasProtocolKeys(body);
			if (!reply.toolCall || hasBlock || reply.error !== undefined || attempt >= TOOL_REDIRECTS) return reply;
			const calls = ((reply.message?.content as { type?: string; id?: string; name?: string }[]) ?? []).filter(
				(b) => b?.type === "toolCall",
			);
			if (progress) progress.step.label += " · Werkzeugaufruf abgewiesen";
			current = [
				...current,
				reply.message,
				...calls.map((c) => ({
					role: "toolResult" as const,
					toolCallId: c.id ?? "",
					toolName: c.name ?? "",
					content: [
						{
							type: "text",
							text: `Tools are not available right now and nothing was executed. Write only the <${config.tag}> block as plain text, nothing else.`,
						},
					],
					isError: true,
					timestamp: Date.now(),
				})),
			];
		}
	}

	function toEntry(turn: Turn, text: string): ProtocolEntryData | undefined {
		const { body } = extractBlock(text, config.tag);
		// without a block only a bare reply that already starts with protocol keys is used, never prose
		const usable =
			body !== undefined
				? body
				: /^[ \t]*[-*•]?[ \t]*[A-Za-z]+[ \t]*:/.test(text.trim().split(/\r?\n/)[0] ?? "")
					? text
					: undefined;
		if (usable === undefined) return undefined;
		const fields = parseBlock(usable);
		if (!fields || (fields.result.length === 0 && fields.decision.length === 0)) return undefined;
		return {
			version: 1,
			userEntryId: turn.userEntryId,
			turn: turn.number,
			source: "backfill",
			fields,
			raw: usable,
		};
	}

	// cut the block out of the answer
	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const parts = message.content;
		for (let i = parts.length - 1; i >= 0; i--) {
			const part = parts[i];
			if (part.type !== "text") continue;
			const { body, rest } = extractBlock(part.text, config.tag);
			if (body === undefined || !hasProtocolKeys(body)) continue;
			const fields = parseBlock(body);
			// keyed by the running turn: a run can span several turns (queued follow-up messages)
			const turn = collectTurns(plainBranch(ctx)).at(-1);
			if (fields && turn) pending.set(turn.userEntryId, { fields, raw: body });
			if (!config.strip) return;
			const content = [...parts];
			content[i] = { ...part, text: rest };
			return { message: { ...message, content } };
		}
	});

	// store the block, or ask for it once
	pi.on("agent_before_settle", async (event, ctx) => {
		if (!enabled) return;
		const branch = plainBranch(ctx);
		const turns = collectTurns(branch);
		const stored = collectProtocols(branch);
		const drafts: ProtocolEntryData[] = [];
		// blocks found during the run, one per turn
		for (const t of turns) {
			const block = pending.get(t.userEntryId);
			if (block && !stored.get(t.userEntryId)?.fields) {
				drafts.push({ version: 1, userEntryId: t.userEntryId, turn: t.number, source: "inline", ...block });
			}
		}
		pending = new Map();

		const turn = turns[turns.length - 1];
		const last = event.context.contextMessages[event.context.contextMessages.length - 1];
		const finished = event.outcome === "completed" && last?.role === "assistant" && last.stopReason === "stop";
		if (
			turn &&
			finished &&
			!stored.get(turn.userEntryId)?.fields &&
			!drafts.some((d) => d.userEntryId === turn.userEntryId)
		) {
			drafts.push(
				config.followUp && protocolModel(ctx, config.auxiliaryModel).model
					? await followUp(event.context.llmMessages, turn, ctx)
					: { version: 1, userEntryId: turn.userEntryId, turn: turn.number, source: "missing" },
			);
		}
		if (!drafts.length) return;
		return {
			entries: [
				...event.entries,
				...drafts.map((data) => ({ type: "custom" as const, customType: PROTOCOL_ENTRY, data })),
			],
		};
	});

	async function followUp(llmMessages: unknown[], turn: Turn, ctx: ExtensionContext): Promise<ProtocolEntryData> {
		const base = { version: 1 as const, userEntryId: turn.userEntryId, turn: turn.number };
		const { model } = protocolModel(ctx, config.auxiliaryModel);
		if (!model) return { ...base, source: "missing" };
		const bar = new Progress(ctx, "protokoll");
		const step = bar.add(`turn ${turn.number}: block missing – asking for it`);
		bar.start(step);
		try {
			const signals = [AbortSignal.timeout(config.followUpTimeoutMs)];
			if (ctx.signal) signals.push(ctx.signal);
			const signal = AbortSignal.any(signals);
			const messages = [
				...(llmMessages as never[]),
				{ role: "user" as const, content: FOLLOW_UP_PROMPT(config.tag), timestamp: Date.now() },
			];
			const reply = await askWithChatContext(ctx, messages, signal, { bar, step });
			if (reply.error !== undefined) {
				bar.finish(step, false, reply.error);
				ctx.ui.notify(`protokoll: follow-up request failed (${reply.error})`, "warning");
				return { ...base, source: "missing" };
			}
			const text = reply.text ?? "";
			const { body } = extractBlock(text, config.tag);
			const fields = parseBlock(body ?? text);
			if (!reply.truncated && fields && (fields.result.length > 0 || fields.decision.length > 0)) {
				bar.finish(step, true);
				return { ...base, source: "followup", fields, raw: body ?? text };
			}
			const reason = failureReason(reply, signal);
			// the model ignored the request: write the block from the transcript right away
			// (no chat context, so no tools to call and no habit of continuing the task)
			if (!signal.aborted) {
				step.label = `turn ${turn.number}: protocol from the transcript (${reason})`;
				const data = await backfillByTranscript(ctx, turn, signal, { bar, step });
				if (data) {
					bar.finish(step, true);
					return data;
				}
			}
			bar.finish(step, false, reason);
			ctx.ui.notify(
				`protokoll: turn ${turn.number} has no protocol (${reason}; transcript: ${lastFailure}) – next attempt at compaction`,
				"warning",
			);
			return { ...base, source: "missing" };
		} catch (error) {
			ctx.ui.notify(
				`protokoll: follow-up request failed (${error instanceof Error ? error.message : String(error)})`,
				"warning",
			);
			return { ...base, source: "missing" };
		} finally {
			bar.close();
		}
	}

	// ------------------------------------------------------------------ compaction

	/**
	 * Thinking level of the extension's own requests. Pi passes a level only when models.json
	 * declares reasoning support, and "off" only through thinkingLevelMap; without that the server
	 * uses its default (for Qwen templates: long thinking). So for OpenAI-compatible servers the
	 * level is also written into the request itself: reasoning_effort, and for "off" additionally
	 * chat_template_kwargs.enable_thinking=false (vLLM, llama.cpp, Strata).
	 */
	/**
	 * Requests that repeat the chat context (follow-up, backfill of the last turn) must look exactly
	 * like the chat's own requests up to the new instruction, or the server cannot reuse its cache.
	 * Chat templates such as Qwen's write the thinking level into the start of the system prompt, so
	 * these requests use the chat's thinking level unchanged, the same way Pi's agent passes it.
	 */
	function chatReasoningOption() {
		// a different model has no chat cache to protect, so its own thinking level applies
		if (config.auxiliaryModel) return reasoningOption();
		const level = pi.getThinkingLevel();
		return level === "off" ? {} : { reasoning: level };
	}

	function reasoningOption(level: ProtocolConfig["followUpReasoning"] = config.followUpReasoning) {
		return {
			...(level === "off" ? {} : { reasoning: level }),
			onPayload: (payload: unknown, model: { api?: string }) => forceThinkingLevel(payload, model, level),
		};
	}

	/** One plain model request; undefined on error, abort or an empty answer. */
	async function ask(
		ctx: ExtensionContext,
		prompt: string,
		maxTokens: number,
		signal?: AbortSignal,
		progress?: { bar: Progress; step: Step },
		level: ProtocolConfig["followUpReasoning"] = config.followUpReasoning,
	) {
		const reply = await callModel(
			ctx,
			config,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ maxTokens, ...(signal ? { signal } : {}), ...reasoningOption(level) },
			progress,
		);
		return reply.text || undefined;
	}

	/**
	 * Writes the missing protocols of condensed turns before the summary is built: the last turn of
	 * the branch from the cached context, earlier ones from their transcript, the turn in progress
	 * as a progress note (not stored, the turn ends with its own block).
	 */
	async function backfillForCompaction(
		branch: PlainEntry[],
		plan: CompactionPlan,
		inProgress: Turn | undefined,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		allowPrefix: boolean,
		bar: Progress,
	): Promise<Map<string, ProtocolEntryData>> {
		const extra = new Map<string, ProtocolEntryData>();
		if (!config.backfill || !protocolModel(ctx, config.auxiliaryModel).model) return extra;
		const protocols = collectProtocols(branch);
		const turns = collectTurns(branch);
		const lastTurn = turns[turns.length - 1];
		const candidates = [...plan.detail.map((b) => b.turn), ...plan.toFold]
			.filter((t) => !protocols.get(t.userEntryId)?.fields && turnHasWork(t))
			.sort((a, b) => b.number - a.number)
			.slice(0, config.backfillMaxPerCompaction);
		// a cut inside the last turn means "still running" only while the agent works; a turn that
		// ended early (aborted, error, output limit) is finished and gets its protocol for good
		const stoppedEarly = (turn: Turn) => {
			const last = [...turn.entries].reverse().find((e) => e.message?.role === "assistant")?.message;
			return ["aborted", "error", "length"].includes(last?.stopReason ?? "");
		};
		const jobs = candidates.map((turn) => {
			const progress = turn === inProgress && !stoppedEarly(turn);
			return {
				turn,
				progress,
				step: bar.add(
					progress
						? `turn ${turn.number} (still running): record progress so far`
						: `turn ${turn.number}: write missing protocol`,
				),
			};
		});
		for (const job of jobs) {
			if (signal?.aborted) break;
			const { turn } = job;
			let data: ProtocolEntryData | undefined;
			if (allowPrefix && turn.userEntryId === lastTurn?.userEntryId) {
				const instruction = job.progress
					? PROGRESS_PROMPT(config.tag)
					: protocols.get(turn.userEntryId)?.source === "missing"
						? FOLLOW_UP_PROMPT(config.tag)
						: INTERRUPTED_PROMPT(config.tag);
				data = await backfillByPrefix(ctx, turn, instruction, signal, { bar, step: job.step });
			}
			if (!data && !signal?.aborted) data = await backfillByTranscript(ctx, turn, signal, { bar, step: job.step });
			if (!data) {
				bar.finish(job.step, false, `${lastFailure} – stays as a shortened transcript`);
				continue;
			}
			extra.set(turn.userEntryId, data);
			// a running turn ends with its own block; everything else is kept for good
			if (!job.progress) pi.appendEntry<ProtocolEntryData>(PROTOCOL_ENTRY, data);
			bar.finish(job.step, true);
		}
		return extra;
	}

	/** Turns per request when index and tags are written for older protocols. */
	const SUPPLEMENT_BATCH = 8;

	/**
	 * /protokoll repair: brings the protocols of this branch to the current form. Turns without a
	 * protocol get one from their transcript; protocols without index/tags get them from their
	 * stored fields. Already repaired turns are skipped, so a second run continues where the
	 * first stopped.
	 */
	async function repair(ctx: ExtensionContext): Promise<{ written: number; supplemented: number; failed: number }> {
		const branch = plainBranch(ctx);
		const turns = collectTurns(branch);
		const protocols = collectProtocols(branch);
		const last = turns[turns.length - 1];
		const missing = turns.filter((t) => !protocols.get(t.userEntryId)?.fields && turnHasWork(t));
		const bare = turns.filter((t) => {
			const f = protocols.get(t.userEntryId)?.fields;
			return f && !f.index?.length && !f.tags?.length;
		});
		const result = { written: 0, supplemented: 0, failed: 0 };
		if (!missing.length && !bare.length) return result;
		const bar = new Progress(ctx, "protokoll repair");
		const jobs = missing.map((turn) => ({
			turn,
			step: bar.add(`turn ${turn.number}: write protocol from the transcript`),
		}));
		const batches: { turns: Turn[]; step: Step }[] = [];
		for (let i = 0; i < bare.length; i += SUPPLEMENT_BATCH) {
			const part = bare.slice(i, i + SUPPLEMENT_BATCH);
			const label = part.length > 1 ? `turns ${part.map((t) => t.number).join(", ")}` : `turn ${part[0].number}`;
			batches.push({ turns: part, step: bar.add(`${label}: index and tags`) });
		}
		try {
			for (const { turn, step } of jobs) {
				// the last turn of a running agent is not finished yet
				if (turn === last && !ctx.isIdle()) {
					bar.finish(step, false, "still running");
					continue;
				}
				const data = await backfillByTranscript(ctx, turn, undefined, { bar, step });
				if (!data) {
					result.failed++;
					bar.finish(step, false, lastFailure);
					continue;
				}
				pi.appendEntry<ProtocolEntryData>(PROTOCOL_ENTRY, data);
				result.written++;
				bar.finish(step, true);
			}
			for (const { turns: part, step } of batches) {
				bar.start(step);
				const items = part.map((t) => ({
					number: t.number,
					user: turnUserText(t.entries, 600, "shortened"),
					fields: protocols.get(t.userEntryId)?.fields as ProtocolFields,
				}));
				const reply = await callModel(
					ctx,
					config,
					{ messages: [{ role: "user", content: supplementPrompt(items), timestamp: Date.now() }] },
					{ maxTokens: config.backfillMaxTokens, ...reasoningOption() },
					{ bar, step },
				);
				const parsed = reply.text && !reply.truncated ? parseSupplement(reply.text) : new Map();
				let ok = 0;
				for (const t of part) {
					const v = parsed.get(t.number);
					if (!v) continue;
					pi.appendEntry<SupplementEntryData>(SUPPLEMENT_ENTRY, {
						userEntryId: t.userEntryId,
						turn: t.number,
						index: v.index,
						tags: v.tags,
					});
					ok++;
				}
				result.supplemented += ok;
				result.failed += part.length - ok;
				if (ok === part.length) bar.finish(step, true);
				else bar.finish(step, ok > 0, ok ? `${part.length - ok} without result` : failureReason(reply));
			}
		} finally {
			bar.close();
		}
		return result;
	}

	interface Assembled {
		summary: string;
		state: FoldState;
		plan: CompactionPlan;
		newlyFolded: number;
		pending: number;
		dropped: string[];
	}

	/**
	 * Builds the tiered summary for a cut. With `useModel` the turns leaving the detail tier are
	 * folded into the state of work and rules/open items are reviewed; without, they appear as
	 * one line each (preview, or when the model is unavailable).
	 */
	async function assemble(
		branch: PlainEntry[],
		cutIndex: number,
		splitTurn: boolean,
		ctx: ExtensionContext,
		useModel: boolean,
		signal?: AbortSignal,
		extra?: Map<string, ProtocolEntryData>,
		bar?: Progress,
	): Promise<Assembled> {
		const rebuild = rebuildRequested(branch);
		const plan = planCompaction({
			config,
			branch,
			cutIndex,
			splitTurn,
			extraProtocols: extra,
			rebuildState: rebuild,
		});
		const protocols = protocolsWith(branch, extra);
		// /protokoll rebuild: start from an empty state and fold every older turn again
		let narrative = rebuild ? "" : (plan.previous?.narrative ?? "");
		const folded = rebuild ? new Set<number>() : decodeRanges(plan.previous?.folded);
		const foreignConsumed = new Set(plan.previous?.foreignConsumed ?? []);
		const index = buildIndex(plan.older, protocols, Math.floor(config.statusMaxTokens * 0.35));

		const condensedProtocols = plan.condensed
			.map((t) => protocols.get(t.userEntryId))
			.filter((p): p is ProtocolEntryData => !!p);
		// reviewed rules of the last compaction plus the rules of turns condensed since then
		const prevRules = plan.previous?.rules;
		const rulesThrough = plan.previous?.rulesThrough ?? 0;
		const newer = plan.condensed
			.filter((t) => t.number > rulesThrough)
			.map((t) => protocols.get(t.userEntryId))
			.filter((p): p is ProtocolEntryData => !!p);
		let rules = prevRules ? activeRules(newer, prevRules) : activeRules(condensedProtocols);
		// a turn cut in the middle ends with its own protocol later: its rules are taken next time
		const finished = splitTurn ? plan.condensed.slice(0, -1) : plan.condensed;
		const lastFinished = finished.length ? finished[finished.length - 1].number : rulesThrough;
		let open = currentOpenItems(condensedProtocols);
		const files = touchedFiles(condensedProtocols, plan.condensed, ctx.cwd);
		// the narrative gets what index and lists leave of the status budget (at least a fifth)
		const narrativeTokens = narrativeBudget(config, { index, rules, open, files });
		const words = Math.max(60, Math.floor(narrativeTokens * 0.7));
		let newlyFolded = 0;

		const foldModel = protocolModel(ctx, config.auxiliaryModel).model;
		const willConsolidate = useModel && config.consolidate && !!foldModel;
		if (useModel && foldModel && (plan.toFold.length || plan.foreign.length)) {
			const chunks = foldInputs(plan, branch, config, extra);
			const steps = chunks.map((c, i) =>
				bar?.add(
					`update state of work${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ""}: ` +
						(c.turns.length ? `turns ${encodeRanges(c.turns)}` : "earlier summary"),
				),
			);
			// listed up front so the whole plan is visible from the start
			if (willConsolidate) bar?.add("review rules and open items");
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				const step = steps[i];
				if (bar && step) bar.start(step);
				const prog = bar && step ? { bar, step } : undefined;
				let next = await ask(
					ctx,
					foldPrompt(narrative, chunk.text, words),
					Math.min(8192, narrativeTokens * 3),
					signal,
					prog,
				);
				if (!next) {
					if (bar && step) bar.finish(step, false, "no answer – next time");
					bar?.skipRest();
					break; // the rest stays pending and is tried again next time
				}
				for (let attempt = 0; attempt < 2 && tok(next) > narrativeTokens && !signal?.aborted; attempt++) {
					if (bar && step && attempt === 0) step.label += " · shorten";
					const shorter = await ask(
						ctx,
						shortenPrompt(next, words),
						Math.min(8192, narrativeTokens * 2),
						signal,
						prog,
					);
					if (!shorter || tok(shorter) >= tok(next)) break;
					next = shorter;
				}
				if (tok(next) > narrativeTokens) {
					// cut the middle, not the end: the newest topics and known problems stand last
					compactNote(
						ctx,
						`protokoll: state of work still too long after shortening (≈${tok(next)} instead of ${narrativeTokens} tokens) – middle cut`,
						"warning",
					);
					next = clipMiddle(
						next,
						narrativeTokens,
						"middle of the state cut at the size limit; protocol_read the [T..] turns for details",
					);
				}
				narrative = next;
				for (const n of chunk.turns) folded.add(n);
				for (const id of chunk.foreignIds) foreignConsumed.add(id);
				newlyFolded += chunk.turns.length;
				if (bar && step) bar.finish(step, true);
			}
		}

		// turns not yet in the narrative need no extra lines: the index lists every older turn
		const pendingTurns = plan.toFold.filter((t) => !folded.has(t.number));
		const pendingForeign = plan.foreign.filter((f) => !foreignConsumed.has(f.id));
		const pendingLines = pendingForeign.map(
			(f) =>
				`[earlier summary, not merged yet] ${clip((f.summary ?? "").replace(/\s+/g, " "), 600, "use protocol_search")}`,
		);
		let notes: string[] = [];
		if (willConsolidate && (rules.length || open.length) && !signal?.aborted) {
			const step = bar
				? (bar.find("review rules and open items") ?? bar.add("review rules and open items"))
				: undefined;
			if (bar && step) bar.start(step);
			const context = clipToTokens(`${narrative}\n\n${plan.detail.map((b) => b.text).join("\n\n")}`, 12000);
			const answer = await ask(
				ctx,
				consolidationPrompt(rules, open, context),
				config.consolidateReasoning === "off" ? 4096 : config.followUpMaxTokens,
				signal,
				bar && step ? { bar, step } : undefined,
				config.consolidateReasoning,
			);
			if (bar && step) bar.finish(step, !!answer, answer ? undefined : "no answer");
			const parsed = answer ? parseConsolidation(answer, rules, open) : undefined;
			if (parsed) {
				const dropped = rules.length - parsed.rules.length + (open.length - parsed.open.length);
				if (dropped)
					compactNote(
						ctx,
						`review: ${rules.length - parsed.rules.length} rules and ${open.length - parsed.open.length} open items removed`,
						"info",
					);
				rules = parsed.rules;
				open = parsed.open;
				notes = parsed.notes;
			} else if (answer) {
				compactNote(ctx, "review answer unreadable – unreviewed lists are kept", "warning");
			}
		}

		const foldedNums = [...folded];
		const covers = foldedNums.length ? `${Math.min(...foldedNums)}–${Math.max(...foldedNums)}` : "";
		const status = renderStatus(
			{
				rules,
				open,
				files,
				narrative,
				index,
				pendingLines,
				notes,
			},
			config,
			covers,
		);
		const dropped = [...status.dropped];
		if (plan.pinnedDropped.length) dropped.push(`pinned turns ${plan.pinnedDropped.join(", ")} did not fit`);
		return {
			summary: renderSummary(status.text, plan.detail, config),
			state: {
				version: 3,
				narrative,
				folded: encodeRanges(folded),
				foreignConsumed: [...foreignConsumed],
				rules,
				rulesThrough: Math.max(rulesThrough, lastFinished),
			},
			plan,
			newlyFolded,
			pending: pendingLines.length + pendingTurns.length,
			dropped,
		};
	}

	pi.on("session_before_compact", async (event, ctx) => {
		if (!enabled || config.compaction !== "protocol") return;
		const bar = new Progress(ctx, "protokoll compaction", (line) =>
			pi.events.emit(PROGRESS_CHANNEL, { ...line, run: "compaction" } satisfies ProgressEvent),
		);
		compactNotes = [];
		showResult(ctx, undefined);
		/** What the pass becomes in the session: one entry with the time of every step. */
		const beganAt = new Date();
		let outcome: CompactEntryData["outcome"] | undefined;
		const counts: CompactCounts = {};
		try {
			const { preparation } = event;
			counts.tokensBefore = preparation.tokensBefore;
			const branch = event.branchEntries as unknown as PlainEntry[];
			const turns = collectTurns(branch);
			const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			if (!window || turns.length === 0) return;
			const room = window - preparation.settings.reserveTokens;
			const keepBudget = Math.max(0, Math.min(Math.floor((window * config.keepRecentPercent) / 100), room - 8192));

			const choice: CutChoice | undefined = chooseCut(
				branch,
				turns,
				config.keepRecentTurns,
				keepBudget,
				entryTokens,
			);
			const candidates: { firstKept: string; split: boolean; kept: number }[] = [];
			if (choice) candidates.push({ firstKept: choice.firstKeptEntryId, split: false, kept: choice.keptTurns });
			candidates.push({ firstKept: preparation.firstKeptEntryId, split: preparation.isSplitTurn, kept: 0 });

			for (const cand of candidates) {
				const cutIndex = branch.findIndex((e) => e.id === cand.firstKept);
				if (cutIndex < 0) continue;
				// fit check with the upper bound before any model call
				const plan = planCompaction({ config, branch, cutIndex, splitTurn: cand.split });
				if (plan.condensed.length === 0) continue;
				let keptTokens = 0;
				for (let i = cutIndex; i < branch.length; i++) keptTokens += entryTokens(branch[i]);
				const detailTokens = plan.detail.reduce((sum, b) => sum + tok(b.text) + 1, 0);
				if (SUMMARY_OVERHEAD + detailTokens + config.statusMaxTokens + keptTokens > room - 4096) continue;

				const inProgress = cand.split ? plan.condensed[plan.condensed.length - 1] : undefined;
				const extra = await backfillForCompaction(
					branch,
					plan,
					inProgress,
					ctx,
					event.signal,
					event.reason !== "overflow",
					bar,
				);
				const a = await assemble(branch, cutIndex, cand.split, ctx, true, event.signal, extra, bar);
				const backfilled = [...extra.values()].filter((d) => d.turn !== inProgress?.number).length;
				compactNote(
					ctx,
					`protokoll: ${a.plan.condensed.length} turns condensed – ${a.plan.detail.length} in detail` +
						(backfilled ? `, ${backfilled} protocols written afterwards` : "") +
						(a.newlyFolded ? `, ${a.newlyFolded} newly folded into the state` : "") +
						(a.pending ? `, ${a.pending} not folded yet (next time)` : "") +
						(a.plan.missingTurns ? `, ${a.plan.missingTurns} without protocol` : "") +
						(cand.split ? ", last turn split" : `, ${cand.kept} kept in full`) +
						(a.dropped.length ? ` · limit reached: ${a.dropped.join(", ")}` : ""),
					a.dropped.length || a.pending ? "warning" : "info",
				);
				outcome = "protocol";
				counts.condensedTurns = a.plan.condensed.length;
				counts.detailTurns = a.plan.detail.length;
				counts.missingTurns = a.plan.missingTurns;
				counts.keptTurns = cand.kept;
				counts.backfilled = backfilled;
				counts.newlyFolded = a.newlyFolded;
				counts.pending = a.pending;
				counts.dropped = a.dropped;
				return {
					compaction: {
						summary: a.summary,
						firstKeptEntryId: cand.firstKept,
						tokensBefore: preparation.tokensBefore,
						details: {
							protokoll: true,
							version: 3,
							status: a.state,
							condensedTurns: a.plan.condensed.length,
							detailTurns: a.plan.detail.length,
							missingTurns: a.plan.missingTurns,
							keptTurns: cand.kept,
						},
					},
				};
			}
			outcome = "no_room";
			compactNote(ctx, "protokoll: the summary would not free enough space – Pi summarizes itself", "warning");
			return;
		} catch (error) {
			outcome = "failed";
			counts.error = error instanceof Error ? error.message : String(error);
			compactNote(
				ctx,
				`protokoll: compaction failed (${error instanceof Error ? error.message : String(error)}) – Pi summarizes itself`,
				"warning",
			);
			return;
		} finally {
			bar.close();
			// a pass that never started (no context window, no turns) leaves no entry behind
			if (outcome)
				pi.appendEntry<CompactEntryData>(COMPACT_ENTRY, {
					version: 1,
					outcome,
					startedAt: beganAt.toISOString(),
					durationMs: bar.elapsed(),
					steps: bar.summary(),
					notes: [...compactNotes],
					...counts,
				});
		}
	});

	// after any compaction (own or Pi's): how big the context is now
	pi.on("session_compact", async (event, ctx) => {
		try {
			const messages = ctx.sessionManager.buildSessionProjection().messages as {
				role: string;
				content?: unknown;
			}[];
			let total = 0;
			let system = 0;
			for (const m of messages) {
				const t = estimateTokens(m as never);
				total += t;
				if (m.role === "system") system += t;
			}
			// same estimate as Pi uses for the messages (4 characters per token)
			const summary = Math.ceil((event.compactionEntry.summary ?? "").length / 4);
			const kept = Math.max(0, total - system - summary);
			const before = event.compactionEntry.tokensBefore;
			const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const line =
				`context after compaction ≈ ${fmt(total)} tokens` +
				(before ? ` (before ${fmt(before)}, −${Math.round((1 - total / before) * 100)} %)` : "") +
				(window ? `, ${Math.round((total / window) * 100)} % of the window` : "") +
				` · system prompt ≈ ${fmt(system)}, summary ≈ ${fmt(summary)}, kept verbatim ≈ ${fmt(kept)}` +
				(event.fromExtension ? "" : " (Pi's own compaction)");
			if (ctx.hasUI)
				showResult(
					ctx,
					[...compactNotes, line].map((l) => `protokoll: ${l.replace(/^protokoll: /, "")}`),
				);
			else ctx.ui.notify(line, "info");
			compactNotes = [];
		} catch {
			// only a display; never disturb the compaction
		}
	});

	// ------------------------------------------------------------------ tool

	pi.registerTool({
		name: TOOL_NAME,
		label: "protokoll: read turn",
		description:
			"Return the original text of an earlier turn of this session (user message, answers, tool calls, shortened tool output; thinking omitted). Use it when the session protocol mentions a turn whose details you need. Turn numbers are those shown in the session protocol.",
		parameters: Type.Object({
			turn: Type.Integer({ minimum: 1, description: "Turn number as shown in the session protocol" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const turns = collectTurns(plainBranch(ctx));
			const turn = turns[params.turn - 1];
			if (!turn) throw new Error(`Turn ${params.turn} does not exist; this session has ${turns.length} turns.`);
			const full = serializeTurn(turn.entries, 4000);
			const text = clip(full, config.lookupMaxTokens * 4, "output limit of protocol_turn reached");
			return {
				content: [{ type: "text", text: `Turn ${turn.number}, original text (thinking omitted):\n\n${text}` }],
				details: { turn: turn.number, chars: full.length, truncated: text.length < full.length },
			};
		},
	});

	pi.registerTool({
		name: READ_TOOL,
		label: "protokoll: read protocols",
		description:
			'Return the full stored protocols of earlier turns of this session (user message verbatim, result, decisions, files, open items, rules). Much shorter than protocol_turn. Use it for turns listed in the index of the session protocol. Argument: turn numbers and ranges, e.g. "12, 40-44" (at most 30 turns).',
		parameters: Type.Object({
			turns: Type.String({ description: 'Turn numbers and ranges, e.g. "12, 40-44"' }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const branch = plainBranch(ctx);
			const turns = collectTurns(branch);
			const protocols = collectProtocols(branch);
			const wanted = [...decodeRanges(params.turns)].sort((a, b) => a - b).slice(0, 30);
			if (!wanted.length)
				throw new Error(`No turn numbers in "${params.turns}"; this session has ${turns.length} turns.`);
			const parts: string[] = [];
			for (const n of wanted) {
				const turn = turns[n - 1];
				if (!turn) {
					parts.push(`### Turn ${n}\n(does not exist; this session has ${turns.length} turns)`);
					continue;
				}
				const f = protocols.get(turn.userEntryId)?.fields;
				const lines = [
					`### Turn ${n}`,
					`User: ${turnUserText(turn.entries, 3000, `full text via protocol_turn(${n})`)}`,
				];
				if (!f) lines.push(`(no protocol for this turn; protocol_turn(${n}) returns the transcript)`);
				else {
					for (const r of f.result) lines.push(`Result: ${r}`);
					for (const d of f.decision) lines.push(`Decision: ${d}`);
					if (f.files.length) lines.push(`Files: ${f.files.join(", ")}`);
					for (const o of f.open.filter((x) => !isNoneItem(x))) lines.push(`Open then: ${o}`);
					for (const r of f.rule.filter((x) => !isNoneItem(x))) lines.push(`Rule: ${r}`);
					for (const r of f.revoke) lines.push(`Revoked: ${r}`);
					for (const o of f.other) lines.push(`Note: ${o}`);
					if (f.tags?.length) lines.push(`Tags: ${f.tags.join(", ")}`);
				}
				parts.push(lines.join("\n"));
			}
			const text = clipToTokens(
				parts.join("\n\n"),
				config.lookupMaxTokens,
				"output limit of protocol_read reached; ask for fewer turns",
			);
			return { content: [{ type: "text", text }], details: { turns: wanted.length } };
		},
	});

	pi.registerTool({
		name: SEARCH_TOOL,
		label: "protokoll: search turns",
		description:
			"Search earlier turns of this session by keywords (user messages, protocols, final answers). Returns turn numbers with a short excerpt, best matches first. Use it to find where something was decided or discussed, then read the turn with protocol_turn.",
		parameters: Type.Object({
			query: Type.String({ description: "Keywords, e.g. file names, function names, topics" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum number of hits" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const max = Math.min(params.limit ?? config.searchMaxResults, config.searchMaxResults);
			const hits = searchTurns(plainBranch(ctx), params.query, max);
			if (!hits.length) {
				return { content: [{ type: "text", text: `No turn matches "${params.query}".` }], details: { hits: 0 } };
			}
			const text = clipToTokens(hits.map((h) => h.text).join("\n\n"), 3000, "more hits cut; refine the query");
			return { content: [{ type: "text", text }], details: { hits: hits.length } };
		},
	});

	// ------------------------------------------------------------------ display

	pi.registerMarkdownTransformer((markdown, context) =>
		enabled && context.messageType === "assistant" ? hideBlocks(markdown, config.tag, context.isStreaming) : markdown,
	);

	pi.registerEntryRenderer<ProtocolEntryData>(PROTOCOL_ENTRY, (entry, { expanded }, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		if (!d.fields) {
			return new Text(theme.fg("warning", `▸ protocol turn ${d.turn}: missing`), 1, 0);
		}
		const f = d.fields;
		const origin = d.source === "followup" ? " (asked for)" : d.source === "backfill" ? " (written afterwards)" : "";
		const head = `▸ protocol turn ${d.turn}${origin}: ${f.result[0] ?? f.decision[0] ?? "–"}`;
		if (!expanded) return new Text(theme.fg("dim", head.length > 160 ? `${head.slice(0, 157)}…` : head), 1, 0);
		const lines = [`protocol turn ${d.turn}${origin}`];
		const add = (label: string, values: string[]) => {
			for (const v of values) lines.push(`  ${label}: ${v}`);
		};
		add("result", f.result);
		add("decision", f.decision);
		if (f.files.length) lines.push(`  files: ${f.files.join(", ")}`);
		add("open", f.open.length ? f.open : ["none"]);
		add("rule", f.rule);
		add("revoke", f.revoke);
		add("note", f.other);
		return new Text(theme.fg("dim", lines.join("\n")), 1, 0);
	});

	pi.registerEntryRenderer<CompactEntryData>(COMPACT_ENTRY, (entry, { expanded }, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		const head = `▸ protokoll ${compactStatusLine(d)}`;
		if (!expanded) return new Text(theme.fg("dim", head.length > 160 ? `${head.slice(0, 157)}…` : head), 1, 0);
		const lines = [head];
		for (const s of d.steps)
			lines.push(
				`  ${s.state === "ok" ? "✓" : s.state === "fail" ? "✗" : "·"} ${s.label}${s.note ? ` – ${s.note}` : ""} · ${compactDuration(s.ms)}`,
			);
		for (const note of d.notes) lines.push(`  ${note}`);
		if (d.error) lines.push(`  error: ${d.error}`);
		return new Text(theme.fg("dim", lines.join("\n")), 1, 0);
	});

	// ------------------------------------------------------------------ command

	const SUB = ["status", "show", "export", "pin", "unpin", "on", "off", "reload", "rebuild", "repair"];
	/** German names of the first versions, still accepted. */
	const ALIASES: Record<string, string> = {
		zeigen: "show",
		anheften: "pin",
		lösen: "unpin",
		loesen: "unpin",
		an: "on",
		aus: "off",
		"neu-laden": "reload",
		"stand-neu": "rebuild",
		heilen: "repair",
	};

	pi.registerCommand("protokoll", {
		description:
			"Session protocol: status | show | export [file] | pin N | unpin N | on | off | reload | rebuild | repair",
		getArgumentCompletions: (prefix) =>
			SUB.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [given = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = ALIASES[given] ?? given;
			const branch = plainBranch(ctx);
			const turns = collectTurns(branch);

			const turnArg = (): { userEntryId: string; number: number } | undefined => {
				const n = Number.parseInt(rest[0] ?? "", 10);
				const t = Number.isInteger(n) ? turns[n - 1] : undefined;
				if (!t) ctx.ui.notify(`turn "${rest[0] ?? ""}" does not exist (1–${turns.length})`, "error");
				return t;
			};

			switch (sub) {
				case "status": {
					const protocols = collectProtocols(branch);
					const written = turns.filter((t) => protocols.get(t.userEntryId)?.fields).length;
					const state = latestFoldState(branch, branch.length);
					const pins = [...collectPins(branch)]
						.map((id) => turns.find((t) => t.userEntryId === id)?.number)
						.filter(Boolean);
					const compactions = branch.filter((e) => e.type === "compaction") as (PlainEntry & {
						timestamp?: string;
						tokensBefore?: number;
					})[];
					const own = compactions.filter(
						(e) => (e.details as { protokoll?: boolean } | undefined)?.protokoll === true,
					);
					const lastC = compactions[compactions.length - 1];
					const when = lastC?.timestamp
						? new Date(lastC.timestamp).toLocaleString(undefined, {
								day: "2-digit",
								month: "2-digit",
								hour: "2-digit",
								minute: "2-digit",
							})
						: "";
					const compactInfo = compactions.length
						? ` · compacted ${compactions.length}× (${own.length} protokoll, ${compactions.length - own.length} Pi)` +
							(when ? `, last ${when}` : "") +
							(lastC?.tokensBefore ? ` at ${fmt(lastC.tokensBefore)} tokens` : "")
						: " · not compacted yet";
					ctx.ui.notify(
						`protokoll ${enabled ? "on" : "off"} · ${turns.length} turns, ${written} with protocol` +
							` · pinned: ${pins.length ? pins.join(", ") : "none"}` +
							` · compaction: ${config.compaction} · kept: ${config.keepRecentTurns} turns / ${config.keepRecentPercent} %` +
							` · detail ≤ ${config.detailMaxTokens}, status ≤ ${config.statusMaxTokens} tokens` +
							(state ? ` · state covers turns ${state.folded || "–"}` : " · no state yet") +
							compactInfo,
						"info",
					);
					return;
				}
				case "show":
				case "export": {
					const keepFrom =
						turns.length > config.keepRecentTurns ? turns[turns.length - config.keepRecentTurns] : undefined;
					const a = await assemble(branch, keepFrom ? keepFrom.index : branch.length, false, ctx, false);
					const text =
						"<!-- Preview without model call: turns not yet folded into the state appear as single lines. -->\n" +
						a.summary;
					if (sub === "show") {
						if (ctx.hasUI) await ctx.ui.editor("Session protocol (view only, changes are discarded)", text);
						else ctx.ui.notify(text, "info");
						return;
					}
					const name = rest.join(" ") || `protokoll-${ctx.sessionManager.getSessionId()}.md`;
					const file = isAbsolute(name) ? name : join(ctx.cwd, name);
					if (existsSync(file)) {
						const ok = ctx.hasUI && (await ctx.ui.confirm("Overwrite file?", file));
						if (!ok) {
							ctx.ui.notify(`not exported, ${file} already exists`, "warning");
							return;
						}
					}
					writeFileSync(
						file,
						`${text}\n${diagnosticAppendix(branch, config, rebuildRequested(branch))}\n`,
						"utf8",
					);
					ctx.ui.notify(`protocol exported: ${file}`, "info");
					return;
				}
				case "pin":
				case "unpin": {
					const t = turnArg();
					if (!t) return;
					pi.appendEntry<PinEntryData>(PIN_ENTRY, { userEntryId: t.userEntryId, pinned: sub === "pin" });
					ctx.ui.notify(
						sub === "pin" ? `turn ${t.number} is kept in full at compaction` : `turn ${t.number} unpinned`,
						"info",
					);
					return;
				}
				case "on":
				case "off": {
					enabled = sub === "on";
					pi.appendEntry<StateEntryData>(STATE_ENTRY, { enabled });
					syncTool();
					ctx.ui.notify(`protokoll ${enabled ? "enabled" : "disabled"} for this session`, "info");
					return;
				}
				case "rebuild": {
					pi.appendEntry(REBUILD_ENTRY, { requested: Date.now() });
					ctx.ui.notify(
						"protokoll: the next compaction rebuilds the state of work from the protocols of all older turns (takes longer)",
						"info",
					);
					return;
				}
				case "repair": {
					if (!protocolModel(ctx, config.auxiliaryModel).model) {
						ctx.ui.notify("protokoll: no model selected", "error");
						return;
					}
					await ctx.waitForIdle();
					const r = await repair(ctx);
					pi.appendEntry(REBUILD_ENTRY, { requested: Date.now() });
					const parts = [
						r.written ? `${r.written} protocols written` : "",
						r.supplemented ? `${r.supplemented} turns given index and tags` : "",
						r.failed ? `${r.failed} without result (running /protokoll repair again continues there)` : "",
					].filter(Boolean);
					ctx.ui.notify(
						`protokoll: ${parts.join(", ") || "all protocols are already in the current form"}. Compacting now and rebuilding the state of work from all protocols.`,
						r.failed ? "warning" : "info",
					);
					ctx.compact({
						onError: (error) =>
							ctx.ui.notify(
								/Nothing to compact|Already compacted/.test(error.message)
									? "protokoll: too little is new since the last compaction, so Pi does not compact yet. The state of work is rebuilt automatically at the next compaction."
									: `protokoll: compaction failed (${error.message}); the rebuild stays requested for the next compaction`,
								"info",
							),
					});
					return;
				}
				case "reload": {
					reload(ctx);
					ctx.ui.notify("protokoll: configuration reloaded", "info");
					return;
				}
				default:
					ctx.ui.notify(`unknown: ${sub}. Possible: ${SUB.join(", ")}`, "error");
			}
		},
	});
}
