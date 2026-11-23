import { describe, expect, it } from "vitest";
import type { PlainEntry, ProtocolEntryData, Turn } from "../src/core.ts";
import {
	ABSTAIN_ANSWER,
	discordant,
	formatQuestionFile,
	lookupQuadrants,
	mcnemarExact,
	parseGenerated,
	parseQuestionFile,
	type QuestionResult,
	questionJudgePrompt,
	questionLeaks,
	questionReport,
	type RecallQuestion,
	rateLine,
	updatePairs,
	wilson,
} from "../src/questions.ts";

const fields = (f: Partial<Record<"result" | "decision" | "rule" | "revoke", string[]>>) => ({
	result: f.result ?? [],
	decision: f.decision ?? [],
	files: [],
	open: [],
	rule: f.rule ?? [],
	revoke: f.revoke ?? [],
	other: [],
});

/** turns and protocols without a real branch: index = number, so cutIndex counts turns */
function session(protos: Parameters<typeof fields>[0][]) {
	const turns: Turn[] = [];
	const protocols = new Map<string, ProtocolEntryData>();
	protos.forEach((p, i) => {
		const id = `u${i + 1}`;
		turns.push({ number: i + 1, userEntryId: id, userEntryIds: [id], index: i, entries: [] as PlainEntry[] });
		protocols.set(id, { turn: i + 1, userEntryId: id, fields: fields(p) } as unknown as ProtocolEntryData);
	});
	return { turns, protocols };
}

describe("statistics", () => {
	it("computes the Wilson interval (checked by hand for 8 of 10)", () => {
		const ci = wilson(8, 10);
		expect(ci?.lo).toBeCloseTo(0.49, 2);
		expect(ci?.hi).toBeCloseTo(0.943, 2);
		// stays inside [0, 1] at the edges and needs at least one item
		expect(wilson(10, 10)?.hi).toBeCloseTo(1, 12);
		expect(wilson(0, 10)?.lo).toBeCloseTo(0, 12);
		expect(wilson(0, 0)).toBeUndefined();
		expect(rateLine(8, 10)).toBe("8/10 = 80 % (95 % CI 49–94 %)");
	});

	it("runs the exact McNemar test on the discordant pairs", () => {
		expect(mcnemarExact(0, 0)).toBe(1);
		// 5 : 0 → 2 · (1/2)^5
		expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10);
		// 10 : 2 → 2 · (C(12,0) + C(12,1) + C(12,2)) / 2^12 = 158/4096
		expect(mcnemarExact(10, 2)).toBeCloseTo(158 / 4096, 10);
		expect(mcnemarExact(2, 10)).toBeCloseTo(158 / 4096, 10);
		expect(mcnemarExact(3, 3)).toBe(1);
		// large counts stay finite
		expect(mcnemarExact(600, 500)).toBeGreaterThan(0);
	});
});

describe("generating questions", () => {
	it("reads QUESTION/ANSWER/OUTDATED lines, also in list or bold form, and NONE as nothing", () => {
		expect(parseGenerated("NONE")).toEqual([]);
		expect(parseGenerated(undefined)).toEqual([]);
		expect(parseGenerated("QUESTION: Warum 2,0?\nANSWER: weil eine Periode in Reserve liegt")).toEqual([
			{ question: "Warum 2,0?", answer: "weil eine Periode in Reserve liegt" },
		]);
		expect(parseGenerated("- **QUESTION:** a?\n- **ANSWER:** b\nOUTDATED: c\nQUESTION: d?")).toEqual([
			{ question: "a?", answer: "b", outdated: "c" },
			{ question: "d?" },
		]);
	});

	it("drops questions that contain a number or identifier of their answer", () => {
		const answer = "The factor is 2.0 in GOSoundSystem.cpp (CALLBACK_TIMING_TOLERANCE_FACTOR).";
		expect(questionLeaks("Why is the tolerance factor in GOSoundSystem.cpp what it is?", answer)).toBe(true);
		expect(questionLeaks("Why is CALLBACK_TIMING_TOLERANCE_FACTOR set the way it is?", answer)).toBe(true);
		expect(questionLeaks("Is the tolerance 2.0?", answer)).toBe(true);
		expect(questionLeaks("Why did we keep the callback tolerance factor where it is?", answer)).toBe(false);
		// ordinary words of the answer are allowed: the question has to name its subject
		expect(questionLeaks("What is the tolerance factor?", answer)).toBe(false);
	});

	it("finds revoked and restated rules first, then similar statements, only with the older turn before the cut", () => {
		const { turns, protocols } = session([
			{ rule: ["always push grandorgue branches to the fork"] },
			{ result: ["buffer size for the ceiling sweep set to 256 frames"] },
			{ result: ["unrelated work on the docs"] },
			{ revoke: ["push grandorgue branches"] },
			{ result: ["buffer size for the ceiling sweep set to 128 frames after the retest"] },
			{ rule: ["always push grandorgue branches to the private mirror"] },
		]);
		const pairs = updatePairs(turns, protocols, 99);
		expect(pairs[0]).toMatchObject({
			via: "rule",
			older: { turn: 1 },
			newer: { turn: 4, text: "Revoked: push grandorgue branches" },
		});
		expect(pairs.some((p) => p.via === "rule" && p.older.turn === 1 && p.newer.turn === 6)).toBe(true);
		expect(pairs.some((p) => p.via === "statement" && p.older.turn === 2 && p.newer.turn === 5)).toBe(true);
		// the rules come before the statements
		const firstStatement = pairs.findIndex((p) => p.via === "statement");
		expect(pairs.slice(firstStatement).every((p) => p.via === "statement")).toBe(true);
		// nothing older than the cut, nothing to pair
		expect(updatePairs(turns, protocols, 0)).toEqual([]);
	});

	it("does not pair a statement with its own identical repetition", () => {
		const { turns, protocols } = session([
			{ result: ["tests pass on the host"] },
			{ result: ["tests pass on the host"] },
		]);
		expect(updatePairs(turns, protocols, 99)).toEqual([]);
	});
});

describe("the question file", () => {
	const questions: RecallQuestion[] = [
		{
			id: "Q1",
			kind: "fact",
			turn: 46,
			question: "Warum blieb der Code ohne Guard?",
			answer: "Der Host hat GCC 13.",
		},
		{
			id: "Q2",
			kind: "abstain",
			question: "Welche Abtastrate haben wir für das Mikro genommen?",
			answer: ABSTAIN_ANSWER,
			check: "no search hit at all",
		},
		{
			id: "Q3",
			kind: "update",
			oldTurn: 10,
			turn: 120,
			question: "Pushen wir die Branches noch?",
			answer: "Nein, nicht mehr.",
			outdated: "Ja, zum Fork.",
		},
	];

	it("writes a file that reads back unchanged", () => {
		const text = formatQuestionFile(questions, { at: "2026-11-23T10:00:00Z", turns: 224 });
		expect(text).toContain("## Q3 · update · turn 10 → 120");
		expect(text).toContain("## Q2 · abstain\n");
		const back = parseQuestionFile(text);
		expect(back.errors).toEqual([]);
		expect(back.questions).toEqual(questions);
	});

	it("takes hand edits: deleted sections, wrapped lines, own questions; reports what it cannot use", () => {
		const text = [
			"# my questions",
			"",
			"## Q1 · fact · turn 46",
			"Question: Warum blieb der Code",
			"  ohne Guard?",
			"Answer: Der Host hat GCC 13.",
			"",
			"## mine · fact",
			"Question: Welche Pufferlänge gilt?",
			"Answer: 128",
			"",
			"## Q9 · opinion",
			"Question: ?",
			"",
			"## Q10 · fact · turn 3",
			"Answer: no question here",
			"",
			"## Q1 · abstain",
			"Question: twice",
		].join("\n");
		const { questions: got, errors } = parseQuestionFile(text);
		expect(got.map((q) => q.id)).toEqual(["Q1", "mine", "Q1"]);
		expect(got[0].question).toBe("Warum blieb der Code ohne Guard?");
		expect(got[1].turn).toBeUndefined();
		expect(got[2].answer).toBe(ABSTAIN_ANSWER);
		expect(errors.some((e) => e.includes("Q9"))).toBe(true);
		expect(errors.some((e) => e.startsWith("Q10"))).toBe(true);
		expect(errors.some((e) => e.includes("used twice"))).toBe(true);
	});
});

describe("judging and the report", () => {
	it("asks the judge per kind", () => {
		const fact = questionJudgePrompt({ id: "Q1", kind: "fact", question: "q?", answer: "ref" }, "ans", "Result: r");
		expect(fact).toContain("Reference answer: ref");
		expect(fact).toContain("What was recorded for that turn: Result: r");
		const abstain = questionJudgePrompt({ id: "Q2", kind: "abstain", question: "q?", answer: ABSTAIN_ANSWER }, "ans");
		expect(abstain).toContain("The session never discussed this question.");
		expect(abstain).toContain("WRONG – it presents an answer as if it had been part of the session");
		const update = questionJudgePrompt(
			{ id: "Q3", kind: "update", question: "q?", answer: "new", outdated: "old" },
			"ans",
		);
		expect(update).toContain("Current state: new");
		expect(update).toContain("Outdated state: old");
	});

	const row = (id: string, kind: RecallQuestion["kind"], a: string, b: string, la = 0, lb = 0): QuestionResult => ({
		q: { id, kind, question: `${id}?`, answer: "x" },
		a: { verdict: a as never, similarity: 0, toolCalls: la, text: `a ${id}` },
		b: { verdict: b as never, similarity: 0, toolCalls: lb, text: `b ${id}` },
		location: kind === "abstain" ? undefined : "older",
	});

	it("splits correct and wrong answers by whether the model looked something up", () => {
		const rows = [
			row("Q1", "fact", "correct", "wrong", 2, 0),
			row("Q2", "fact", "wrong", "correct", 1, 0),
			row("Q3", "abstain", "unknown", "correct"),
		];
		expect(lookupQuadrants(rows.map((r) => r.a))).toEqual({
			correctLookup: 1,
			correctNoLookup: 0,
			wrongLookup: 1,
			wrongNoLookup: 0,
			other: 1,
		});
		expect(discordant(rows)).toEqual({ onlyA: 1, onlyB: 2 });
	});

	it("reports rates with intervals per kind, the paired test and every answer", () => {
		const rows = [
			row("Q1", "fact", "correct", "unknown", 1, 2),
			row("Q2", "fact", "correct", "correct"),
			row("Q3", "abstain", "wrong", "correct"),
			row("Q4", "update", "correct", "wrong"),
		];
		const md = questionReport(rows, {
			file: "q.md",
			fold: false,
			tools: true,
			modelCalls: 20,
			skipped: ["Q9: bad"],
		}).join("\n");
		expect(md).toContain("| all | 4 | 3/4 = 75 % (95 % CI");
		expect(md).toContain("| abstain | 1 | 0/1 = 0 %");
		expect(md).toContain("only A correct 2, only B correct 1, p = 1.000");
		expect(md).toContain("## Looked up or answered from memory");
		expect(md).toContain("| A (1 lookups) | 1 | 2 | 0 | 1 | 0 |");
		expect(md).toContain("3 only as index line or in the state of work");
		expect(md).toContain("- Q9: bad");
		expect(md).toContain("### Q3 · abstain — A: wrong (0 lookups) · B: correct (0 lookups)");
		expect(md).toContain("Wilson score interval");
		// without tools there is no lookup table
		expect(
			questionReport(rows, { file: "q.md", fold: false, tools: false, modelCalls: 1, skipped: [] }).join("\n"),
		).not.toContain("Looked up or answered");
	});
});
