/**
 * Question sets for `/protokoll recall`: questions about the content of a session, generated once by
 * the model, curated by hand and then frozen in a Markdown file, so every version of the extension
 * can be measured against the same questions. Pure functions only – the commands live in index.ts.
 *
 * Three kinds:
 *  - fact:    about one turn (a result, a value, a decision or its reason)
 *  - abstain: about something the session never discussed; the right answer is "not in this session"
 *  - update:  about something that changed during the session; only the newer state is right
 */

import {
	clip,
	isNoneItem,
	type ProtocolEntryData,
	type ProtocolFields,
	RECALL_VERDICTS,
	type RecallAnswer,
	type RecallVerdict,
	similarity,
	type Turn,
	turnUserText,
} from "./core.ts";

export type QuestionKind = "fact" | "abstain" | "update";
export const QUESTION_KINDS: QuestionKind[] = ["fact", "abstain", "update"];

export interface RecallQuestion {
	/** stable name inside the file, e.g. "Q7" */
	id: string;
	kind: QuestionKind;
	/** fact: the turn the question is about; update: the turn with the newer state */
	turn?: number;
	/** update: the turn with the older state */
	oldTurn?: number;
	question: string;
	/** the reference answer; for abstain the fixed text ABSTAIN_ANSWER */
	answer: string;
	/** update: the state that is no longer valid */
	outdated?: string;
	/** abstain: what the keyword search found closest, for the curator */
	check?: string;
}

export const ABSTAIN_ANSWER = "(never discussed in this session)";
/** upper bound for --make-questions N */
export const MAX_GENERATED_QUESTIONS = 300;
/** user message and protocol text a generation request sees of one turn */
const GEN_USER_CHARS = 1500;
/** topic lines given to the abstain request */
const GEN_TOPIC_LINES = 150;

// ------------------------------------------------------------------ generation prompts

function fieldLines(f: ProtocolFields): string[] {
	return [
		...f.result.map((r) => `Result: ${r}`),
		...f.decision.map((d) => `Decision: ${d}`),
		...f.rule.filter((r) => !isNoneItem(r)).map((r) => `Rule: ${r}`),
	];
}

const SHARED_RULES = [
	"- Ask the way the user writes, in the language of the user's messages.",
	"- Name the subject so the question has one clear answer, but do not give the answer away: no numbers, identifiers, file names or values from the answer in the question.",
	"- Do not mention turns, protocols, summaries or 'earlier you wrote'.",
];

/** One fact question about one turn, from its user message and protocol. */
export function factQuestionPrompt(userText: string, fields: ProtocolFields): string {
	return [
		"You write test questions for the memory of a coding assistant. Below is one turn of a long session: the user's message and the protocol the assistant wrote about it.",
		"",
		"Write ONE question the user could ask much later in the same session about a concrete fact of this turn: a result, a value, a name, a decision or the reason for it.",
		...SHARED_RULES,
		"- The answer must follow from the protocol alone.",
		"If the turn holds nothing concrete to ask about, reply NONE.",
		"",
		"Format exactly:",
		"QUESTION: …",
		"ANSWER: … (one or two sentences)",
		"",
		`User message: ${clip(userText.trim(), GEN_USER_CHARS, "shortened").replace(/\s+/g, " ")}`,
		"",
		"Protocol:",
		...fieldLines(fields),
	].join("\n");
}

/** Questions about things the session never discussed, built next to its real topics. */
export function abstainQuestionPrompt(topics: string[], count: number): string {
	return [
		"You write test questions for the memory of a coding assistant. Below are the topics of a long session, one line per turn.",
		"",
		`Write ${count} questions the user could plausibly ask about this project whose answer was NEVER part of the session: details right next to the topics (a parameter that was not discussed, a component that was not touched, a measurement that was not taken, a decision that was never made).`,
		'They must sound like questions about something that happened in this session ("Which … did we choose for …?"), so a model that does not check is tempted to make an answer up.',
		"- in the language of the topic lines",
		"- not answerable from the list, not even partly",
		"- each about a different subject",
		"",
		"Format: one per line, nothing else:",
		"QUESTION: …",
		"",
		"Topics:",
		...topics,
	].join("\n");
}

/** Checks whether a newer statement replaced an older one and, if so, writes the question. */
export function updateQuestionPrompt(
	older: { turn: number; text: string },
	newer: { turn: number; text: string },
): string {
	return [
		"Two statements from different turns of a long coding session, about the same subject.",
		"",
		`Older: ${older.text}`,
		`Newer: ${newer.text}`,
		"",
		"Does the newer statement replace, revoke or correct the older one, so that the older one is no longer valid? If not – they are about different things, or the newer one only adds to the older one – reply NONE.",
		"If it does, write ONE question the user could ask at the end of the session about the current state: its correct answer is the newer statement, and the older statement would be the outdated answer.",
		...SHARED_RULES,
		"",
		"Format exactly:",
		"QUESTION: …",
		"ANSWER: … (the current state)",
		"OUTDATED: … (the old state)",
	].join("\n");
}

export interface GeneratedQuestion {
	question: string;
	answer?: string;
	outdated?: string;
}

/** Reads QUESTION/ANSWER/OUTDATED lines; NONE or nothing usable gives an empty list. */
export function parseGenerated(text: string | undefined): GeneratedQuestion[] {
	if (!text) return [];
	const out: GeneratedQuestion[] = [];
	let cur: GeneratedQuestion | undefined;
	for (const raw of text.split("\n")) {
		const line = raw
			.trim()
			.replace(/^[-*]\s+/, "")
			.replace(/^\*\*(\w+):\*\*/, "$1:");
		const m = /^(QUESTION|ANSWER|OUTDATED)\s*:\s*(.*)$/i.exec(line);
		if (!m) continue;
		const key = m[1].toUpperCase();
		const value = m[2].trim();
		if (!value) continue;
		if (key === "QUESTION") {
			cur = { question: value };
			out.push(cur);
		} else if (cur && key === "ANSWER") cur.answer = value;
		else if (cur && key === "OUTDATED") cur.outdated = value;
	}
	return out;
}

/**
 * True when the question hands out the answer: a number or an identifier-like token of the answer
 * (digits, `_`, `.`, `/`, `::`, inner capitals) appears in the question.
 */
export function questionLeaks(question: string, answer: string): boolean {
	const q = question.toLowerCase();
	const tokens = answer.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
	return tokens
		.map((t) => t.replace(/^[.:/-]+|[.:/-]+$/g, ""))
		.filter((t) => t.length >= 3 && (/\d/.test(t) || /[_/]|::|\.\w/.test(t) || /\p{Ll}\p{Lu}/u.test(t)))
		.some((t) => q.includes(t.toLowerCase()));
}

/** One line per turn for the abstain request: the index line, else the first result. */
export function topicLines(turns: Turn[], protocols: Map<string, ProtocolEntryData>): string[] {
	const lines: string[] = [];
	for (const t of turns) {
		const f = protocols.get(t.userEntryId)?.fields;
		const head = f?.index?.[0] ?? f?.result[0] ?? f?.decision[0];
		if (head) lines.push(`- ${head.replace(/\s+/g, " ").slice(0, 200)}`);
	}
	if (lines.length <= GEN_TOPIC_LINES) return lines;
	// evenly over the whole session
	return Array.from({ length: GEN_TOPIC_LINES }, (_, i) => lines[Math.floor((i * lines.length) / GEN_TOPIC_LINES)]);
}

export interface UpdatePair {
	older: { turn: number; text: string };
	newer: { turn: number; text: string };
	/** rule: a rule revoked or restated; statement: similar results or decisions */
	via: "rule" | "statement";
	score: number;
}

const normText = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/**
 * Pairs of turns where a later statement may have replaced an earlier one. Rules that were revoked
 * or restated come first; then results and decisions that resemble an earlier one without being the
 * same. The older turn has to lie before `cutIndex`. Whether a pair is a real revision is left to the
 * model (`updateQuestionPrompt` may answer NONE).
 */
export function updatePairs(turns: Turn[], protocols: Map<string, ProtocolEntryData>, cutIndex: number): UpdatePair[] {
	type Stmt = { turn: Turn; text: string; rule: boolean };
	const seen: Stmt[] = [];
	const rules: UpdatePair[] = [];
	const statements: UpdatePair[] = [];
	const taken = new Set<string>();
	const add = (list: UpdatePair[], p: UpdatePair) => {
		const key = `${p.older.turn}>${p.newer.turn}`;
		if (taken.has(key)) return;
		taken.add(key);
		list.push(p);
	};
	for (const t of turns) {
		const f = protocols.get(t.userEntryId)?.fields;
		if (!f) continue;
		const earlier = seen.filter((s) => s.turn.index < cutIndex);
		for (const r of f.revoke) {
			const nr = normText(r);
			if (!nr) continue;
			const old = [...earlier]
				.reverse()
				.find((s) => s.rule && (normText(s.text).includes(nr) || nr.includes(normText(s.text))));
			if (old)
				add(rules, {
					older: { turn: old.turn.number, text: `Rule: ${old.text}` },
					newer: { turn: t.number, text: `Revoked: ${r}` },
					via: "rule",
					score: 1,
				});
		}
		const own: Stmt[] = [
			...f.rule.filter((r) => !isNoneItem(r)).map((text) => ({ turn: t, text, rule: true })),
			...[...f.result, ...f.decision].map((text) => ({ turn: t, text, rule: false })),
		];
		for (const s of own) {
			let best: { stmt: Stmt; sim: number } | undefined;
			for (const e of earlier) {
				if (e.rule !== s.rule) continue;
				const sim = similarity(e.text, s.text);
				// identical wording is a repetition, not a revision
				if (sim < 0.35 || sim >= 0.95) continue;
				if (!best || sim > best.sim) best = { stmt: e, sim };
			}
			if (!best) continue;
			const label = s.rule ? "Rule" : "Statement";
			add(s.rule ? rules : statements, {
				older: { turn: best.stmt.turn.number, text: `${label}: ${best.stmt.text}` },
				newer: { turn: t.number, text: `${label}: ${s.text}` },
				via: s.rule ? "rule" : "statement",
				score: best.sim,
			});
		}
		seen.push(...own);
	}
	statements.sort((a, b) => b.score - a.score);
	return [...rules, ...statements];
}

// ------------------------------------------------------------------ the question file

export function formatQuestionFile(questions: RecallQuestion[], meta: { at: string; turns: number }): string {
	const out = [
		"# protokoll recall questions",
		"",
		`Generated ${meta.at.slice(0, 10)} from a session with ${meta.turns} turns. Curate freely: delete a`,
		"section to drop a question, edit any text, add your own. Kinds: fact – about one turn; abstain –",
		'never discussed, the right answer is "not in this session"; update – the answer changed during the',
		"session, only the newer state is right. Keep the heading line of a section as `## <id> · <kind> ·",
		"turn N` (update: `turn N → M`, abstain: no turn). Run them with",
		"`/protokoll recall --questions <this file>`.",
		"",
	];
	for (const q of questions) {
		const where =
			q.kind === "update" && q.oldTurn !== undefined && q.turn !== undefined
				? ` · turn ${q.oldTurn} → ${q.turn}`
				: q.turn !== undefined
					? ` · turn ${q.turn}`
					: "";
		out.push(`## ${q.id} · ${q.kind}${where}`, "", `Question: ${q.question}`, `Answer: ${q.answer}`);
		if (q.outdated) out.push(`Outdated: ${q.outdated}`);
		if (q.check) out.push(`Check: ${q.check}`);
		out.push("");
	}
	return out.join("\n");
}

/** Reads a (possibly hand-edited) question file. Sections that cannot be used are reported, not guessed. */
export function parseQuestionFile(text: string): { questions: RecallQuestion[]; errors: string[] } {
	const questions: RecallQuestion[] = [];
	const errors: string[] = [];
	const sections = text.split(/^##[ \t]+/m).slice(1);
	for (const sec of sections) {
		const [head = "", ...body] = sec.split("\n");
		const parts = head.split(/\s+[·|]\s+/).map((p) => p.trim());
		const id = parts[0] ?? "";
		const kind = (parts[1] ?? "").toLowerCase() as QuestionKind;
		if (!id || !QUESTION_KINDS.includes(kind)) {
			errors.push(`"## ${head.trim()}": the heading needs "<id> · fact|abstain|update"`);
			continue;
		}
		const nums = (parts.slice(2).join(" ").match(/\d+/g) ?? []).map(Number);
		const fields: Record<string, string> = {};
		let key: string | undefined;
		for (const raw of body) {
			const line = raw.trim();
			const m = /^(Question|Answer|Outdated|Check)\s*:\s*(.*)$/i.exec(line);
			if (m) {
				key = m[1].toLowerCase();
				fields[key] = m[2].trim();
			} else if (key && line) fields[key] = `${fields[key]} ${line}`.trim();
			else if (!line) key = undefined;
		}
		if (!fields.question) {
			errors.push(`${id}: no "Question:" line`);
			continue;
		}
		const q: RecallQuestion = {
			id,
			kind,
			question: fields.question,
			answer: kind === "abstain" ? fields.answer || ABSTAIN_ANSWER : (fields.answer ?? ""),
		};
		if (kind !== "abstain" && !q.answer) {
			errors.push(`${id}: no "Answer:" line`);
			continue;
		}
		if (kind === "update") {
			if (nums.length >= 2) {
				q.oldTurn = nums[0];
				q.turn = nums[1];
			} else if (nums.length === 1) q.turn = nums[0];
			if (fields.outdated) q.outdated = fields.outdated;
		} else if (kind === "fact" && nums.length) q.turn = nums[0];
		if (fields.check) q.check = fields.check;
		questions.push(q);
	}
	const ids = new Set<string>();
	for (const q of questions) {
		if (ids.has(q.id)) errors.push(`${q.id}: used twice – the results would mix them up`);
		ids.add(q.id);
	}
	return { questions, errors };
}

// ------------------------------------------------------------------ asking and judging

/** What the model is asked: the question as written, plus the request for a short answer. */
export function askText(q: RecallQuestion): string {
	return `${q.question}\n\nAnswer in two or three sentences.`;
}

/**
 * The judge request for one answer. `record` is the protocol text of the turn when the session still
 * has it (fact questions); the reference answer from the file always goes along.
 */
export function questionJudgePrompt(q: RecallQuestion, answer: string, record = ""): string {
	const head = [
		"You check an answer a coding assistant gave about an earlier part of its own long session.",
		"",
		"Reply with exactly one word:",
	];
	if (q.kind === "abstain")
		return [
			...head,
			"CORRECT – the answer says this was not discussed, cannot be found or is not known",
			"PARTIAL – it says it cannot find it, but still offers a guess that is clearly marked as a guess",
			"WRONG – it presents an answer as if it had been part of the session",
			"",
			"The session never discussed this question.",
			"",
			`Question: ${q.question}`,
			"",
			`Answer: ${answer}`,
		].join("\n");
	if (q.kind === "update")
		return [
			...head,
			"CORRECT – the answer gives the current state",
			"PARTIAL – it names both states without making clear which one holds now, or only part of the current state",
			"UNKNOWN – it says it does not know or cannot find it",
			"WRONG – it gives the outdated state as the current one, or something else that does not match",
			"",
			`Question: ${q.question}`,
			"",
			`Current state: ${q.answer}`,
			...(q.outdated ? [`Outdated state: ${q.outdated}`] : []),
			"",
			`Answer: ${answer}`,
		].join("\n");
	return [
		...head,
		"CORRECT – the answer states the core of the reference (details may be missing)",
		"PARTIAL – part of the core is right, but important parts are missing or off",
		"UNKNOWN – it says it does not know, cannot find it, or only says how it would look it up",
		"WRONG – it asserts something that does not match the reference",
		"",
		`Question: ${q.question}`,
		"",
		`Reference answer: ${q.answer}`,
		...(record ? ["", `What was recorded for that turn: ${record}`] : []),
		"",
		`Answer: ${answer}`,
	].join("\n");
}

// ------------------------------------------------------------------ statistics

/** z for a two-sided 95 % interval */
export const Z95 = 1.959964;

/**
 * Wilson score interval for a proportion k/n. Better coverage than the normal approximation for small
 * n and for rates near 0 or 1, and it never leaves [0, 1]. Undefined for n = 0.
 */
export function wilson(k: number, n: number, z = Z95): { lo: number; hi: number } | undefined {
	if (n <= 0) return undefined;
	const p = k / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * Exact two-sided McNemar test for paired yes/no results: b = items only A got right, c = items only
 * B got right. Under the null hypothesis (A and B equally good) each of the b + c discordant items
 * goes either way with probability 1/2, so p = 2 · P(X ≤ min(b, c)) for X ~ Binomial(b + c, 1/2),
 * capped at 1. Items both got right or both got wrong carry no information about the difference.
 */
export function mcnemarExact(b: number, c: number): number {
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.min(b, c);
	// sum of binomial probabilities in log space, stable for a few thousand items
	let logC = 0; // log C(n, 0)
	let sum = 0;
	const log2n = n * Math.log(2);
	for (let i = 0; i <= k; i++) {
		if (i > 0) logC += Math.log((n - i + 1) / i);
		sum += Math.exp(logC - log2n);
	}
	return Math.min(1, 2 * sum);
}

function pct(x: number): string {
	return `${Math.round(x * 100)} %`;
}

/** "17/20 = 85 % (95 % CI 64–95 %)" */
export function rateLine(k: number, n: number): string {
	const ci = wilson(k, n);
	if (!ci) return "–";
	return `${k}/${n} = ${pct(k / n)} (95 % CI ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)} %)`;
}

export interface QuestionResult {
	q: RecallQuestion;
	/** where the turn of a fact question was at run time */
	location?: "older" | "detail" | "kept" | "missing";
	a: RecallAnswer;
	b: RecallAnswer;
}

function counts(rows: RecallAnswer[]): Record<RecallVerdict, number> {
	const t = Object.fromEntries(RECALL_VERDICTS.map((v) => [v, 0])) as Record<RecallVerdict, number>;
	for (const r of rows) t[r.verdict]++;
	return t;
}

/** Correct and wrong answers split by whether the model looked something up first. */
export function lookupQuadrants(rows: RecallAnswer[]): {
	correctLookup: number;
	correctNoLookup: number;
	wrongLookup: number;
	wrongNoLookup: number;
	other: number;
} {
	const q = { correctLookup: 0, correctNoLookup: 0, wrongLookup: 0, wrongNoLookup: 0, other: 0 };
	for (const r of rows) {
		const looked = (r.toolCalls ?? 0) > 0;
		if (r.verdict === "correct") looked ? q.correctLookup++ : q.correctNoLookup++;
		else if (r.verdict === "wrong") looked ? q.wrongLookup++ : q.wrongNoLookup++;
		else q.other++;
	}
	return q;
}

/** The two numbers of the paired test: only A correct, only B correct. */
export function discordant(rows: QuestionResult[]): { onlyA: number; onlyB: number } {
	let onlyA = 0;
	let onlyB = 0;
	for (const r of rows) {
		const a = r.a.verdict === "correct";
		const b = r.b.verdict === "correct";
		if (a && !b) onlyA++;
		if (b && !a) onlyB++;
	}
	return { onlyA, onlyB };
}

export function questionSummaryLine(rows: QuestionResult[]): string {
	const ca = rows.filter((r) => r.a.verdict === "correct").length;
	const cb = rows.filter((r) => r.b.verdict === "correct").length;
	const d = discordant(rows);
	return (
		`A ${rateLine(ca, rows.length)} · B ${rateLine(cb, rows.length)} · ` +
		`McNemar p = ${mcnemarExact(d.onlyA, d.onlyB).toFixed(3)} (only A ${d.onlyA}, only B ${d.onlyB})`
	);
}

const answerCell = (a: RecallAnswer) =>
	`${a.verdict}${typeof a.toolCalls === "number" ? ` (${a.toolCalls} lookups)` : ""}`;

export function questionReport(
	rows: QuestionResult[],
	meta: { file: string; fold: boolean; tools: boolean; modelCalls: number; skipped: string[] },
): string[] {
	const out = [
		"# protokoll recall – question set",
		"",
		`Questions: ${meta.file} (${rows.length} asked${meta.skipped.length ? `, ${meta.skipped.length} skipped` : ""}).`,
		"Every question was asked twice: against the summary as it stands (A) and against the same summary",
		"without the state of work (B). " +
			(meta.fold
				? "The state of work was folded with the model for this run. "
				: "The stored state of work was used as it is. ") +
			(meta.tools
				? "The model had the lookup tools (protocol_search, protocol_read, protocol_turn), as in a real session."
				: "The requests carried no tools: only what the summary itself holds counts."),
		"",
		"## Correct answers",
		"",
		"| kind | n | A (with state of work) | B (without) |",
		"|---|---|---|---|",
	];
	const groups: [string, QuestionResult[]][] = [
		["all", rows],
		...QUESTION_KINDS.map((k) => [k, rows.filter((r) => r.q.kind === k)] as [string, QuestionResult[]]),
	];
	for (const [name, list] of groups) {
		if (!list.length) continue;
		const ca = list.filter((r) => r.a.verdict === "correct").length;
		const cb = list.filter((r) => r.b.verdict === "correct").length;
		out.push(`| ${name} | ${list.length} | ${rateLine(ca, list.length)} | ${rateLine(cb, list.length)} |`);
	}
	const d = discordant(rows);
	out.push(
		"",
		`Paired comparison A vs B (exact McNemar test): only A correct ${d.onlyA}, only B correct ${d.onlyB}, ` +
			`p = ${mcnemarExact(d.onlyA, d.onlyB).toFixed(3)}.`,
		"",
		"## All verdicts",
		"",
		`| | ${RECALL_VERDICTS.join(" | ")} |`,
		`|---|${RECALL_VERDICTS.map(() => "---").join("|")}|`,
	);
	for (const [label, side] of [
		["A", rows.map((r) => r.a)],
		["B", rows.map((r) => r.b)],
	] as [string, RecallAnswer[]][]) {
		const c = counts(side);
		out.push(`| ${label} | ${RECALL_VERDICTS.map((v) => c[v]).join(" | ")} |`);
	}
	if (meta.tools) {
		out.push(
			"",
			"## Looked up or answered from memory",
			"",
			"| | correct, looked up | correct, from the summary | wrong, looked up | wrong, without looking up | other |",
			"|---|---|---|---|---|---|",
		);
		for (const [label, side] of [
			["A", rows.map((r) => r.a)],
			["B", rows.map((r) => r.b)],
		] as [string, RecallAnswer[]][]) {
			const q = lookupQuadrants(side);
			const calls = side.reduce((s, r) => s + (r.toolCalls ?? 0), 0);
			out.push(
				`| ${label} (${calls} lookups) | ${q.correctLookup} | ${q.correctNoLookup} | ${q.wrongLookup} | ${q.wrongNoLookup} | ${q.other} |`,
			);
		}
	}
	const located = rows.filter((r) => r.location);
	if (located.length) {
		const by = (l: string) => located.filter((r) => r.location === l).length;
		out.push(
			"",
			`Where the turns of the fact and update questions were at run time: ${by("older")} only as index line or in the state of work, ` +
				`${by("detail")} quoted in the detail tier, ${by("kept")} still in the context word for word` +
				(by("missing") ? `, ${by("missing")} not in this session` : "") +
				".",
		);
	}
	if (meta.skipped.length) out.push("", "Skipped:", ...meta.skipped.map((s) => `- ${s}`));
	out.push(
		"",
		"## Legend",
		"",
		"- correct = the core of the reference is right (details may be missing); for abstain: says it was not discussed; for update: gives the current state",
		"- partial = part of it; for abstain: says it cannot find it but still guesses; for update: names both states without saying which holds",
		"- unknown = says it does not know; wrong = asserts something that does not match – for abstain: presents an answer as if it had been discussed (made up); for update: gives the outdated state",
		"- lookup = tried to call a lookup tool although none was available; unscored = the judge gave no usable verdict",
		"- rate = correct answers / questions. 95 % CI = Wilson score interval: computed from k correct out of n, it covers the true rate (the chance of a correct answer to a question drawn from the same kind of questions) in 95 % of repeated samples. It holds for this question set and this session, and it does not cover a judge that is systematically too strict or too lenient.",
		"- McNemar: A and B answer the same questions, so only the questions where exactly one of them is correct say anything about the difference. p = probability of a split at least this uneven if A and B were equally good; below 0.05 is the usual threshold.",
		`- model calls: ${meta.modelCalls}`,
		"",
		"## Questions",
		"",
	);
	for (const r of rows) {
		const turn =
			r.q.kind === "update" && r.q.oldTurn !== undefined
				? ` · turn ${r.q.oldTurn} → ${r.q.turn ?? "?"}`
				: r.q.turn !== undefined
					? ` · turn ${r.q.turn}`
					: "";
		out.push(
			`### ${r.q.id} · ${r.q.kind}${turn} — A: ${answerCell(r.a)} · B: ${answerCell(r.b)}`,
			"",
			`Question: ${r.q.question}`,
			"",
			`Reference: ${r.q.answer}`,
			...(r.q.outdated ? ["", `Outdated: ${r.q.outdated}`] : []),
			"",
			`Answer A: ${(r.a.text ?? "(no answer)").replace(/\n+/g, " ")}`,
			"",
			`Answer B: ${(r.b.text ?? "(no answer)").replace(/\n+/g, " ")}`,
			"",
		);
	}
	return out;
}

/** The turn text a fact question is judged against, when the session still has the protocol. */
export function recordOf(protocol: ProtocolEntryData | undefined): string {
	const f = protocol?.fields;
	if (!f) return "";
	return fieldLines(f).join("\n");
}

/** User text of a turn for the generation request. */
export function genUserText(t: Turn): string {
	return turnUserText(t.entries, GEN_USER_CHARS, "shortened");
}
