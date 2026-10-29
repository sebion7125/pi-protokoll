import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activeRules,
	buildIndex,
	COMPACT_ENTRY,
	type CompactEntryData,
	chooseCut,
	cleanFileEntry,
	clipMiddle,
	collectProtocols,
	collectTurns,
	compactDuration,
	compactStatusLine,
	currentOpenItems,
	DEFAULT_CONFIG,
	decodeRanges,
	diagnosticAppendix,
	encodeRanges,
	extractBlock,
	type FoldState,
	foldInputs,
	hasProtocolKeys,
	hideBlocks,
	isUnsupportedModelCall,
	loadConfig,
	mergeConfig,
	narrativeBudget,
	type PlainEntry,
	type ProtocolConfig,
	type ProtocolEntryData,
	parseBlock,
	parseConsolidation,
	parseModelRef,
	parseSupplement,
	planCompaction,
	renderDetailBlock,
	renderStatus,
	renderSummary,
	renumberLegacyState,
	reviewIsSubset,
	SUPPLEMENT_ENTRY,
	searchTurns,
	splitList,
	supplementPrompt,
	systemPromptSection,
	tok,
	toolCallFiles,
	touchedFiles,
	turnHasWork,
} from "../src/core.ts";

let seq = 0;
const id = () => `e${++seq}`;
const user = (text: string): PlainEntry => ({ id: id(), type: "message", message: { role: "user", content: text } });
const assistant = (text: string, toolCall?: { name: string; arguments: Record<string, unknown> }): PlainEntry => ({
	id: id(),
	type: "message",
	message: {
		role: "assistant",
		stopReason: toolCall ? "toolUse" : "stop",
		content: [{ type: "text", text }, ...(toolCall ? [{ type: "toolCall", id: "c", ...toolCall }] : [])],
	},
});
const tool = (name: string, text: string): PlainEntry => ({
	id: id(),
	type: "message",
	message: { role: "toolResult", toolName: name, content: [{ type: "text", text }] },
});
const protocol = (userEntryId: string, turn: number, body: string): PlainEntry => ({
	id: id(),
	type: "custom",
	customType: "protokoll",
	data: {
		version: 1,
		userEntryId,
		turn,
		source: "inline",
		fields: parseBlock(body),
		raw: body,
	} satisfies ProtocolEntryData,
});

describe("extractBlock", () => {
	it("cuts the last block and keeps the answer", () => {
		const r = extractBlock("Done.\n\n<protocol>\nresult: x\n</protocol>\n", "protocol");
		expect(r.body).toBe("result: x");
		expect(r.rest).toBe("Done.");
	});
	it("treats an unclosed block as running to the end", () => {
		const r = extractBlock("Answer\n<protocol>\nresult: cut off", "protocol");
		expect(r.body).toBe("result: cut off");
		expect(r.rest).toBe("Answer");
	});
	it("keeps text after the block", () => {
		const r = extractBlock("A\n<protocol>result: x</protocol>\nB", "protocol");
		expect(r.rest).toBe("A\n\nB");
	});
	it("returns the text unchanged without a block", () => {
		expect(extractBlock("plain", "protocol")).toEqual({ body: undefined, rest: "plain" });
	});
	it("leaves a tag quoted in an inline code span alone", () => {
		const text = "Heute: Inline-`<protocol>`-Blöcke und auxiliaryModel.";
		const r = extractBlock(text, "protocol");
		expect(r.body).toBeUndefined();
		expect(r.rest).toBe(text);
	});
	it("ignores an example block inside a fenced code block", () => {
		const text = "Example:\n```\n<protocol>\nresult: example\n</protocol>\n```\nThat is the format.";
		const r = extractBlock(text, "protocol");
		expect(r.body).toBeUndefined();
		expect(r.rest).toBe(text);
	});
	it("prefers the trailing block and keeps a quoted example in the answer", () => {
		const text =
			"Example:\n```\n<protocol>\nresult: example\n</protocol>\n```\nReal answer.\n<protocol>\nresult: real\n</protocol>";
		const r = extractBlock(text, "protocol");
		expect(r.body).toBe("result: real");
		expect(r.rest).toContain("Real answer.");
		expect(r.rest).toContain("result: example");
	});
	it("keeps prose after a block written early in the answer", () => {
		const r = extractBlock("A\n<protocol>\nresult: early\n</protocol>\nand the answer continues here", "protocol");
		expect(r.body).toBe("result: early");
		expect(r.rest).toBe("A\n\nand the answer continues here");
	});
	it("does not treat an unclosed tag inside a sentence as a block", () => {
		const text = "see <protocol> for the format, and here is the rest of the answer";
		const r = extractBlock(text, "protocol");
		expect(r.body).toBeUndefined();
		expect(r.rest).toBe(text);
	});
});

describe("hasProtocolKeys", () => {
	it("recognises protocol keys and their aliases", () => {
		expect(hasProtocolKeys("result: x")).toBe(true);
		expect(hasProtocolKeys("- summary: x")).toBe(true);
		expect(hasProtocolKeys("prose, no keys")).toBe(false);
	});
});

describe("hideBlocks", () => {
	it("hides complete blocks", () => {
		expect(hideBlocks("Hi\n<protocol>\nresult: x\n</protocol>", "protocol", false)).toBe("Hi");
	});
	it("hides an unfinished block and a half-typed tag while streaming", () => {
		expect(hideBlocks("Hi\n<protocol>\nresu", "protocol", true)).toBe("Hi");
		expect(hideBlocks("Hi\n<proto", "protocol", true)).toBe("Hi");
		expect(hideBlocks("a < b", "protocol", true)).toBe("a < b");
	});
	it("keeps an example block quoted in a fence visible", () => {
		const md = "Example:\n```\n<protocol>\nresult: x\n</protocol>\n```";
		expect(hideBlocks(md, "protocol", false)).toBe(md);
		expect(hideBlocks(md, "protocol", true)).toBe(md);
	});
	it("keeps prose around a tag quoted in a code span while streaming", () => {
		const md = "Heute: Inline-`<protocol>`-Blöcke und der Rest der Antwort.";
		expect(hideBlocks(md, "protocol", true)).toBe(md);
	});
	it("does not cut the answer at a tag that sits inside a sentence", () => {
		const md = "see <protocol> for the format\nand the rest of the answer";
		expect(hideBlocks(md, "protocol", true)).toBe(md);
	});
});

describe("parseBlock", () => {
	it("reads keys, repeats and continuation lines", () => {
		const f = parseBlock(
			"result: built terrain\ndecision: use GLX\ndecision: no SDL\nopen: shadows\n- fog\nrule: tuples only",
		);
		expect(f?.result).toEqual(["built terrain"]);
		expect(f?.decision).toEqual(["use GLX", "no SDL"]);
		expect(f?.open).toEqual(["shadows", "fog"]);
		expect(f?.rule).toEqual(["tuples only"]);
	});
	it("maps aliases and keeps an explicit 'none'", () => {
		const f = parseBlock("Decisions: a\nopen: none");
		expect(f?.decision).toEqual(["a"]);
		expect(f?.open).toEqual(["none"]);
	});
	it("returns undefined for an empty block", () => {
		expect(parseBlock("  \n ")).toBeUndefined();
	});
});

describe("activeRules", () => {
	it("adds, deduplicates and revokes", () => {
		const p = (rule: string[], revoke: string[] = []) =>
			({
				version: 1,
				userEntryId: "x",
				turn: 1,
				source: "inline",
				fields: { result: [], decision: [], files: [], open: [], rule, revoke, other: [] },
			}) as ProtocolEntryData;
		expect(
			activeRules([
				p(["Use tuples, not lists", "German comments"]),
				p(["use tuples, not lists"]),
				p([], ["tuples"]),
			]),
		).toEqual(["German comments"]);
	});
});

describe("chooseCut", () => {
	const branch = [
		user("q1"),
		assistant("a1"),
		user("q2"),
		assistant("a2"),
		user("q3"),
		assistant("a3"),
		user("q4"),
		assistant("a4"),
	];
	const turns = collectTurns(branch);
	const est = () => 10;
	it("keeps at most keepTurns whole turns", () => {
		const c = chooseCut(branch, turns, 3, 1000, est);
		expect(c?.keptTurns).toBe(3);
		expect(c?.firstKeptEntryId).toBe(turns[1].userEntryId);
	});
	it("keeps fewer turns when the budget is smaller", () => {
		expect(chooseCut(branch, turns, 3, 40, est)?.keptTurns).toBe(2);
	});
	it("never keeps everything", () => {
		expect(chooseCut(branch, turns, 10, 1000, est)?.keptTurns).toBe(3);
	});
	it("gives up when the last turn alone is too big", () => {
		expect(chooseCut(branch, turns, 3, 15, est)).toBeUndefined();
	});
});

/** n turns, each with a protocol; returns the branch and the user entries. */
function session(
	n: number,
	opts: { userText?: (i: number) => string; protocolFor?: (i: number) => string | undefined } = {},
) {
	const branch: PlainEntry[] = [];
	const users: PlainEntry[] = [];
	for (let i = 1; i <= n; i++) {
		const u = user(opts.userText?.(i) ?? `question ${i}`);
		users.push(u);
		branch.push(u, assistant(`answer ${i}`));
		const body = opts.protocolFor ? opts.protocolFor(i) : `result: result ${i}\nopen: item ${i}`;
		if (body !== undefined) branch.push(protocol(u.id, i, body));
	}
	return { branch, users };
}

const cfg = (over: Partial<ProtocolConfig> = {}): ProtocolConfig => ({ ...DEFAULT_CONFIG, ...over });

describe("planCompaction", () => {
	it("shows the newest turns in detail within the budget and folds the rest", () => {
		const { branch } = session(40);
		const plan = planCompaction({
			config: cfg({ detailMaxTokens: 300 }),
			branch,
			cutIndex: branch.length,
			splitTurn: false,
		});
		expect(plan.condensed.length).toBe(40);
		expect(plan.detail.length).toBeGreaterThan(2);
		expect(plan.detail.length).toBeLessThan(40);
		expect(plan.detail.at(-1)?.turn.number).toBe(40);
		const used = plan.detail.reduce((s, b) => s + tok(b.text) + 1, 0);
		expect(used).toBeLessThanOrEqual(300);
		expect(plan.toFold.map((t) => t.number)).toEqual(plan.older.map((t) => t.number));
		expect(plan.toFold[0].number).toBe(1);
	});

	it("puts pinned turns into the detail tier and skips turns already folded", () => {
		const { branch, users } = session(20);
		const pin: PlainEntry = {
			id: id(),
			type: "custom",
			customType: "protokoll-pin",
			data: { userEntryId: users[1].id, pinned: true },
		};
		const state: FoldState = { version: 2, narrative: "earlier", folded: "1-5", foreignConsumed: [] };
		const own: PlainEntry = {
			id: id(),
			type: "compaction",
			summary: "x",
			firstKeptEntryId: users[10].id,
			details: { protokoll: true, status: state },
		};
		const b = [...branch, pin, own];
		const plan = planCompaction({
			config: cfg({ detailMaxTokens: 400 }),
			branch: b,
			cutIndex: b.length,
			splitTurn: false,
		});
		expect(plan.detail.some((d) => d.turn.number === 2 && d.pinned)).toBe(true);
		expect(plan.previous?.narrative).toBe("earlier");
		expect(plan.toFold.some((t) => t.number <= 5)).toBe(false);
	});

	it("shows a pinned turn with its tool calls in full", () => {
		const u = user("write the terrain");
		const b: PlainEntry[] = [
			u,
			assistant("ok", { name: "write", arguments: { path: "terrain.c" } }),
			tool("write", "written"),
			assistant("done"),
			protocol(u.id, 1, "result: terrain written"),
			{ id: id(), type: "custom", customType: "protokoll-pin", data: { userEntryId: u.id, pinned: true } },
			user("next"),
			assistant("x"),
		];
		const plan = planCompaction({ config: cfg(), branch: b, cutIndex: b.length - 2, splitTurn: false });
		expect(plan.detail[0].pinned).toBe(true);
		expect(plan.detail[0].text).toContain('write(path="terrain.c")');
		expect(plan.detail[0].text).toContain("[Tool result write]: written");
	});

	it("takes a summary written by Pi as foreign input and skips the turns without protocol it covers", () => {
		const { branch, users } = session(12, { protocolFor: (i) => (i <= 4 ? undefined : `result: r${i}`) });
		const pi: PlainEntry = { id: id(), type: "compaction", summary: "PI SUMMARY", firstKeptEntryId: users[4].id };
		const b = [...branch, pi];
		const plan = planCompaction({
			config: cfg({ detailMaxTokens: 100 }),
			branch: b,
			cutIndex: b.length,
			splitTurn: false,
		});
		expect(plan.foreign.map((f) => f.summary)).toEqual(["PI SUMMARY"]);
		expect(plan.toFold.some((t) => t.number <= 4)).toBe(false);
	});

	it("includes the user message in the digest when keepUserMessages is off", () => {
		const { branch } = session(3, { protocolFor: () => undefined });
		const plan = planCompaction({
			config: cfg({ keepUserMessages: false }),
			branch,
			cutIndex: branch.length,
			splitTurn: false,
		});
		expect(plan.detail[0].text).toContain("[User]: question 1");
		expect(plan.missingTurns).toBe(3);
	});

	it("marks a split turn as in progress", () => {
		const { branch } = session(3);
		const plan = planCompaction({ config: cfg(), branch, cutIndex: branch.length - 1, splitTurn: true });
		expect(plan.detail.at(-1)?.inProgress).toBe(true);
		expect(plan.detail.at(-1)?.text).toContain("Turn 3 (in progress)");
	});
});

describe("foldInputs", () => {
	it("splits into chunks below the limit and reports their turns", () => {
		const { branch } = session(60, { userText: (i) => `question ${i} ${"x".repeat(250)}` });
		const config = cfg({ detailMaxTokens: 0, foldChunkTokens: 2000 });
		const plan = planCompaction({ config, branch, cutIndex: branch.length, splitTurn: false });
		const chunks = foldInputs(plan, branch, config);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(tok(c.text)).toBeLessThanOrEqual(2000);
		expect(chunks.flatMap((c) => c.turns)).toEqual(plan.toFold.map((t) => t.number));
	});
});

describe("status", () => {
	it("never exceeds statusMaxTokens", () => {
		const config = cfg({ statusMaxTokens: 1000 });
		const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p} ${i} ${"word ".repeat(12)}`);
		const { text, dropped } = renderStatus(
			{
				rules: many(80, "rule"),
				open: many(80, "open"),
				files: Array.from({ length: 200 }, (_, i) => ({ path: `src/file${i}.c`, turn: i })),
				narrative: "state ".repeat(3000),
				pendingLines: many(300, "[T] line"),
				notes: many(10, "note"),
			},
			config,
			"1–300",
		);
		expect(tok(text)).toBeLessThanOrEqual(1000);
		expect(dropped.length).toBeGreaterThan(0);
		expect(text).toContain("protocol_search");
	});

	it("keeps everything when it fits", () => {
		const { text, dropped } = renderStatus(
			{
				rules: ["tuples only"],
				open: ["fog"],
				files: [{ path: "a.c", turn: 3 }],
				narrative: "Terrain works [T3].",
				pendingLines: [],
				notes: [],
			},
			cfg(),
			"1–3",
		);
		expect(dropped).toEqual([]);
		expect(text).toContain("- tuples only");
		expect(text).toContain("a.c [T3]");
		expect(text).toContain("State of work (covers turns 1–3)");
	});

	it("renders the whole summary", () => {
		const { branch } = session(4);
		const plan = planCompaction({ config: cfg(), branch, cutIndex: branch.length, splitTurn: false });
		const text = renderSummary("STATUS", plan.detail, cfg());
		expect(text).toContain("protocol_search");
		expect(text).toContain("### Turn 4");
		expect(text).toContain("User: question 4");
	});
});

describe("lists", () => {
	const p = (turn: number, body: string) =>
		({ version: 1, userEntryId: `u${turn}`, turn, source: "inline", fields: parseBlock(body) }) as ProtocolEntryData;
	it("keeps the last stated open items when a later protocol omits the key", () => {
		expect(currentOpenItems([p(1, "result: a\nopen: fog\nopen: shadows"), p(2, "result: b")])).toEqual([
			"fog",
			"shadows",
		]);
		expect(currentOpenItems([p(1, "open: fog"), p(2, "open: none")])).toEqual([]);
	});
	it("orders files by the turn that touched them last", () => {
		expect(touchedFiles([p(1, "files: a.c, b.c"), p(2, "files: a.c")])).toEqual([
			{ path: "a.c", turn: 2 },
			{ path: "b.c", turn: 1 },
		]);
	});
	it("encodes and decodes turn ranges", () => {
		expect(encodeRanges([5, 1, 2, 3, 7, 8])).toBe("1-3,5,7-8");
		expect([...decodeRanges("1-3,5,7-8")]).toEqual([1, 2, 3, 5, 7, 8]);
	});
});

describe("searchTurns", () => {
	it("ranks by matched words and phrase", () => {
		const { branch } = session(5, {
			userText: (i) =>
				i === 2 ? "please add shadow mapping to terrain.c" : i === 4 ? "fix the shadow acne" : `other ${i}`,
		});
		const hits = searchTurns(branch, "shadow mapping", 5);
		expect(hits[0].turn).toBe(2);
		expect(hits.map((h) => h.turn)).toContain(4);
		expect(hits[0].text).toContain("shadow mapping");
		expect(searchTurns(branch, "zzz", 5)).toEqual([]);
	});
});

describe("consolidation", () => {
	const rules = [
		"10 s runtime is enough",
		"10 s Laufzeit reicht",
		"measure with terrain off",
		"decided to use tuples",
	];
	const open = ["fix fade", "billboard"];
	it("keeps the chosen entries in their original wording", () => {
		const r = parseConsolidation("RULES: R1, R3\nOPEN: O2\nNOTES:\n- R2 duplicates R1 in German", rules, open);
		expect(r).toEqual({
			rules: ["10 s runtime is enough", "measure with terrain off"],
			open: ["billboard"],
			notes: ["R2 duplicates R1 in German"],
		});
	});
	it("reads ranges, bare numbers and none", () => {
		expect(parseConsolidation("RULES: R1-R3\nOPEN: none", rules, open)?.rules).toHaveLength(3);
		expect(parseConsolidation("RULES: 4\nOPEN: 1, 2", rules, open)?.open).toEqual(open);
	});
	it("rejects other forms, rewritten text and dropping every rule", () => {
		expect(parseConsolidation("Sure! Here is the list", rules, open)).toBeUndefined();
		expect(parseConsolidation("RULES:\n- deploy on friday\nOPEN: none", rules, open)).toBeUndefined();
		expect(parseConsolidation("RULES: none\nOPEN: none", rules, open)).toBeUndefined();
		expect(parseConsolidation("RULES: R9\nOPEN: none", rules, open)).toBeUndefined();
	});
	it("detects invented items", () => {
		expect(reviewIsSubset(["use tuples, never lists"], ["Use tuples never lists"])).toBe(true);
		expect(reviewIsSubset(["use tuples"], ["deploy to production on Friday"])).toBe(false);
	});
});

describe("loadConfig", () => {
	it("merges global and project files and reports bad keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "protokoll-"));
		const agent = join(dir, "agent");
		const project = join(dir, "project");
		mkdirSync(agent);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agent, "protokoll.json"), JSON.stringify({ keepRecentTurns: 5, maxWords: "x", bogus: 1 }));
		writeFileSync(
			join(project, ".pi", "protokoll.json"),
			JSON.stringify({ keepRecentTurns: 2, compaction: "default" }),
		);
		const { config, warnings } = loadConfig(agent, project);
		expect(config.keepRecentTurns).toBe(2);
		expect(config.compaction).toBe("default");
		expect(config.maxWords).toBe(DEFAULT_CONFIG.maxWords);
		expect(warnings.length).toBe(2);
	});
});

describe("v3: files, digests, progress", () => {
	const p = (turn: number, body: string) =>
		({ version: 1, userEntryId: `u${turn}`, turn, source: "inline", fields: parseBlock(body) }) as ProtocolEntryData;

	it("does not split file names at commas inside braces", () => {
		expect(splitList("/tmp/tier{3,2,0}.ppm, /tmp/a.c; f(x, y).txt")).toEqual([
			"/tmp/tier{3,2,0}.ppm",
			"/tmp/a.c",
			"f(x, y).txt",
		]);
		expect(touchedFiles([p(2, "files: /tmp/tier{3,2,0}.ppm, b.c")]).map((f) => f.path)).toEqual([
			"/tmp/tier{3,2,0}.ppm",
			"b.c",
		]);
	});

	it("takes changed files from edit and write calls, relative to the project", () => {
		const u = user("make it");
		const entries = [
			u,
			assistant("", { name: "read", arguments: { path: "/home/x/proj/src/r.c" } }),
			assistant("", { name: "edit", arguments: { path: "/home/x/proj/src/scene.h", edits: [] } }),
			assistant("", { name: "write", arguments: { path: "/tmp/test_lod.c", content: "x" } }),
			assistant("", { name: "edit", arguments: { path: "/home/x/proj/src/scene.h" } }),
		];
		expect(toolCallFiles(entries, "/home/x/proj")).toEqual(["src/scene.h", "/tmp/test_lod.c"]);
		const turns = collectTurns(entries);
		const files = touchedFiles([p(1, "files: /home/x/proj/src/scene.h")], turns, "/home/x/proj");
		expect(files).toEqual([
			{ path: "src/scene.h", turn: 1 },
			{ path: "/tmp/test_lod.c", turn: 1 },
		]);
	});

	it("keeps start and end of a long digest", () => {
		const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
		const out = clipMiddle(text, 200, "middle cut");
		expect(out).toContain("line 0");
		expect(out).toContain("line 399");
		expect(out).toContain("middle cut");
		expect(tok(out)).toBeLessThanOrEqual(200);
	});

	it("shows the end of a turn without protocol, not only its start", () => {
		const u = user("mach weiter");
		const entries = [u];
		for (let i = 0; i < 60; i++) {
			entries.push(assistant(`step ${i}`, { name: "bash", arguments: { command: `make ${i}` } }));
			entries.push(tool("bash", `output ${i} `.repeat(30)));
		}
		entries.push(assistant("Final: tier bands done"));
		const turn = collectTurns(entries)[0];
		expect(turnHasWork(turn)).toBe(true);
		const text = renderDetailBlock(turn, undefined, {
			config: cfg({ digestMaxTokens: 800 }),
			pinned: false,
			inProgress: false,
			entries,
		});
		expect(text).toContain("step 0");
		expect(text).toContain("Final: tier bands done");
	});

	it("renders the progress of a turn in progress", () => {
		const u = user("mach weiter");
		const entries = [u, assistant("working", { name: "bash", arguments: { command: "make" } })];
		const turn = collectTurns(entries)[0];
		const text = renderDetailBlock(turn, p(1, "result: S1 done\nopen: S2 card bending"), {
			config: cfg(),
			pinned: false,
			inProgress: true,
			entries,
		});
		expect(text).toContain("(in progress)");
		expect(text).toContain("Progress so far");
		expect(text).toContain("Result: S1 done");
		expect(text).toContain("Still to do: S2 card bending");
	});

	it("uses protocols written during compaction", () => {
		const { branch } = session(4);
		// drop the protocol of turn 2
		const turns = collectTurns(branch);
		const t2 = turns[1];
		const without = branch.filter((e) => !(e.customType === "protokoll" && (e.data as ProtocolEntryData).turn === 2));
		const extra = new Map([[t2.userEntryId, { ...p(2, "result: backfilled two"), userEntryId: t2.userEntryId }]]);
		const plan = planCompaction({
			config: cfg(),
			branch: without,
			cutIndex: without.length,
			splitTurn: false,
			extraProtocols: extra,
		});
		expect(plan.detail.map((b) => b.text).join("\n")).toContain("Result: backfilled two");
		expect(plan.missingTurns).toBe(0);
	});
});

describe("runs with messages sent while the agent works", () => {
	/** u1 → tool call → [steer u2] → tool call → [steer u3] → final answer; then a new run u4. */
	const steeredSession = () => {
		const u1 = user("build the trees");
		const u2 = user("the leaves are red");
		const u3 = user("budget higher");
		const u4 = user("next topic");
		const branch: PlainEntry[] = [
			u1,
			assistant("", { name: "bash", arguments: { command: "make" } }),
			tool("bash", "ok"),
			u2,
			assistant("", { name: "edit", arguments: { path: "src/a.c" } }),
			tool("edit", "ok"),
			u3,
			assistant("done"),
			protocol(u3.id, 3, "result: trees built"), // stored by an older version under the steering message
			u4,
			assistant("ok"),
		];
		return { branch, u1, u2, u3, u4 };
	};

	it("counts a run with steering messages as one turn", () => {
		const { branch, u1, u2, u3, u4 } = steeredSession();
		const turns = collectTurns(branch);
		expect(turns.map((t) => t.userEntryId)).toEqual([u1.id, u4.id]);
		expect(turns[0].userEntryIds).toEqual([u1.id, u2.id, u3.id]);
		expect(turns[1].number).toBe(2);
	});

	it("files a protocol stored under a steering message to its run", () => {
		const { branch, u1 } = steeredSession();
		expect(collectProtocols(branch).get(u1.id)?.fields?.result).toEqual(["trees built"]);
	});

	it("keeps every user message of the run in the detail block", () => {
		const { branch } = steeredSession();
		const turn = collectTurns(branch)[0];
		const text = renderDetailBlock(turn, undefined, {
			config: cfg(),
			pinned: false,
			inProgress: false,
			entries: turn.entries,
		});
		expect(text).toContain("User: build the trees");
		expect(text).toContain("[while the assistant worked] the leaves are red");
		expect(text).toContain("[while the assistant worked] budget higher");
	});

	it("prefers the protocol of the latest message in a run over a later stored partial one", () => {
		const { branch, u1, u2 } = steeredSession();
		// an older version backfilled the middle part afterwards (appended at the end of the branch)
		branch.push(protocol(u2.id, 2, "result: partial middle part"));
		expect(collectProtocols(branch).get(u1.id)?.fields?.result).toEqual(["trees built"]);
	});

	it("does not let a missing marker hide a written protocol", () => {
		const { branch, u1 } = steeredSession();
		branch.push({
			id: "m",
			type: "custom",
			customType: "protokoll",
			data: { version: 1, userEntryId: u1.id, turn: 1, source: "missing" },
		});
		expect(collectProtocols(branch).get(u1.id)?.source).toBe("inline");
	});

	it("renumbers a state written with one turn per user message", () => {
		const { branch } = steeredSession();
		// old numbering: u1=1, u2=2, u3=3, u4=4
		const state: FoldState = {
			version: 2,
			narrative: "trees built [T3], next [T4]",
			folded: "1-3",
			foreignConsumed: [],
		};
		const s3 = renumberLegacyState(branch, state);
		expect(s3.version).toBe(3);
		expect(s3.folded).toBe("1");
		expect(s3.narrative).toBe("trees built [T1], next [T2]");
	});
});

describe("tidy lists from real sessions", () => {
	const p = (turn: number, body: string) =>
		({ version: 1, userEntryId: `u${turn}`, turn, source: "inline", fields: parseBlock(body) }) as ProtocolEntryData;

	it("keeps one wording of a rule the model restated", () => {
		const rules = activeRules([
			p(1, "rule: for test runs 10 s runtime is enough, a screenshot exists by then (also in the VM)"),
			p(2, "rule: test runs need only 10 s runtime, a screenshot exists by then (also in the VM)"),
			p(3, "rule: verify with landscape switched off when measuring tree colour"),
		]);
		expect(rules).toEqual([
			"test runs need only 10 s runtime, a screenshot exists by then (also in the VM)",
			"verify with landscape switched off when measuring tree colour",
		]);
	});

	it("reduces file entries to paths", () => {
		expect(cleanFileEntry("STATUS.md (commits 7e44efc, 1a897c5)")).toBe("STATUS.md");
		expect(cleanFileEntry("/tmp/ez-tree (clone)")).toBe("/tmp/ez-tree");
		expect(cleanFileEntry("src/trees_cpu.c — debug prints, uncommitted")).toBe("src/trees_cpu.c");
		expect(cleanFileEntry("earlier commit 9151618 emit_cap for non-terminal branch ends")).toBeUndefined();
		expect(cleanFileEntry("/tmp/tier{3,2,0}.ppm")).toBe("/tmp/tier{3,2,0}.ppm");
		const files = touchedFiles([
			p(
				1,
				"files: STATUS.md (commits 7e44efc, 1a897c5, 8b89396), src/main.c (all committed as 5c0aa56 and 24389dc)",
			),
			p(2, "files: STATUS.md"),
		]);
		expect(files).toEqual([
			{ path: "STATUS.md", turn: 2 },
			{ path: "src/main.c", turn: 1 },
		]);
	});

	it("accepts a review that merges two rules into one", () => {
		const input = [
			"verify with landscape switched off (DEMO_NOTERRAIN) when measuring tree colour",
			"verify leaf colour by same-camera forced-tier diff, not with full-scene green masks",
		];
		expect(
			reviewIsSubset(input, ["verify leaf colour with landscape switched off or by same-camera forced-tier diff"]),
		).toBe(true);
		expect(reviewIsSubset(input, ["deploy on friday afternoon"])).toBe(false);
	});

	it("marks a turn without any answer instead of an empty transcript", () => {
		const entries = [user("mach weiter")];
		const turn = collectTurns(entries)[0];
		const text = renderDetailBlock(turn, undefined, { config: cfg(), pinned: false, inProgress: false, entries });
		expect(text).toContain("User: mach weiter");
		expect(text).toContain("no answer recorded");
	});
});

describe("branches", () => {
	it("keeps the summary of a side branch the user left in the condensed turn", () => {
		const u1 = user("try approach A");
		const u2 = user("next");
		const branch: PlainEntry[] = [
			u1,
			assistant("done A"),
			protocol(u1.id, 1, "result: A tried"),
			{
				id: "bs",
				type: "branch_summary",
				summary: "Approach B was tried on a side branch and failed: shader too slow",
			},
			u2,
			assistant("ok"),
		];
		const plan = planCompaction({ config: cfg(), branch, cutIndex: branch.indexOf(u2), splitTurn: false });
		expect(plan.detail[0].text).toContain("Side branch explored and left: Approach B was tried");
		const digest = renderDetailBlock(collectTurns(branch)[0], undefined, {
			config: cfg(),
			pinned: false,
			inProgress: false,
			entries: collectTurns(branch)[0].entries,
		});
		expect(digest).toContain("Summary of a side branch the user left");
	});
});

describe("shell commands the user ran", () => {
	it("keeps !-commands with their output and leaves !!-commands out", () => {
		const u = user("look at this");
		const entries: PlainEntry[] = [
			u,
			assistant("ok"),
			protocol(u.id, 1, "result: looked"),
			{
				id: "b1",
				type: "message",
				message: { role: "bashExecution", command: "make 2>&1 | tail", output: "error: x undeclared" } as never,
			},
			{
				id: "b2",
				type: "message",
				message: { role: "bashExecution", command: "ls secret", output: "s", excludeFromContext: true } as never,
			},
		];
		const turn = collectTurns(entries)[0];
		const text = renderDetailBlock(turn, parseProtocol(u.id), {
			config: cfg(),
			pinned: false,
			inProgress: false,
			entries,
		});
		expect(text).toContain("User ran in the shell: make 2>&1 | tail");
		expect(text).toContain("error: x undeclared");
		expect(text).not.toContain("ls secret");
	});
	function parseProtocol(id: string): ProtocolEntryData {
		return { version: 1, userEntryId: id, turn: 1, source: "inline", fields: parseBlock("result: looked") };
	}
});

describe("context edits", () => {
	it("leaves out answers Pi removed from the context", () => {
		const u = user("q");
		const bad = assistant("failed attempt");
		const branch: PlainEntry[] = [
			u,
			bad,
			{ id: "ce", type: "context_edit", targetId: bad.id, replacement: null } as PlainEntry,
			assistant("good answer"),
		];
		const turn = collectTurns(branch)[0];
		expect(turn.entries.some((e) => e.id === bad.id)).toBe(false);
		expect(serializeTurnText(turn.entries)).toContain("good answer");
	});
	function serializeTurnText(entries: PlainEntry[]) {
		return entries.map((e) => JSON.stringify(e.message?.content ?? "")).join(" ");
	}
});

describe("index of older turns", () => {
	it("lists every older turn while it fits and groups the oldest when it does not", () => {
		const { branch } = session(120, { protocolFor: (i) => `result: shader change number ${i} for the canopy cards` });
		const turns = collectTurns(branch);
		const protocols = collectProtocols(branch);
		const all = buildIndex(turns.slice(0, 10), protocols, 5000);
		expect(all).toHaveLength(10);
		expect(all[0]).toBe("[T1] shader change number 1 for the canopy cards");
		const tight = buildIndex(turns, protocols, 800);
		expect(tight.at(-1)).toContain("[T120]");
		expect(tight[0]).toMatch(/^\[T1–T\d+\]/);
		expect(tight[0]).toContain("shader change number 1 for the… (T1)");
		expect(tight.reduce((s, l) => s + tok(l) + 1, 0)).toBeLessThanOrEqual(800);
	});

	it("uses the index line and search terms the model wrote with the turn", () => {
		const { branch } = session(60, {
			protocolFor: (i) =>
				`result: long result text ${i}\nindex: canopy step ${i} done\ntags: canopy cards, ${i % 2 ? "alpha fizzle" : "Blattfarbe"}`,
		});
		const turns = collectTurns(branch);
		const protocols = collectProtocols(branch);
		expect(buildIndex(turns.slice(0, 1), protocols, 5000)).toEqual(["[T1] canopy step 1 done"]);
		const tight = buildIndex(turns, protocols, 400);
		expect(tight[0]).toMatch(/^\[T1–T\d+\] canopy cards \(T1–T\d+\); alpha fizzle \(T1, T3, /);
		expect(tight[0]).toContain("Blattfarbe (T2, T4");
		expect(tight.reduce((s, l) => s + tok(l) + 1, 0)).toBeLessThanOrEqual(400);
	});

	it("fills index and tags of old protocols from /protokoll heilen without replacing the model's own", () => {
		const parsed = parseSupplement(
			"T3\nindex: palette wald chosen\ntags: Blattfarbe, DEMO_LEAFPAL\n\n**T4**\nindex: only half",
		);
		expect([...parsed.keys()]).toEqual([3]);
		const { branch } = session(4, {
			protocolFor: (i) => (i === 4 ? "result: r4\nindex: own line\ntags: own" : `result: r${i}`),
		});
		const turns = collectTurns(branch);
		const sup = (n: number, index: string) => ({
			type: "custom",
			customType: SUPPLEMENT_ENTRY,
			id: `s${n}`,
			data: { userEntryId: turns[n - 1].userEntryId, turn: n, index: [index], tags: ["x"] },
		});
		const protocols = collectProtocols([...branch, sup(3, "palette wald chosen"), sup(4, "later")] as never);
		expect(protocols.get(turns[2].userEntryId)?.fields?.index).toEqual(["palette wald chosen"]);
		expect(protocols.get(turns[3].userEntryId)?.fields?.index).toEqual(["own line"]);
		expect(supplementPrompt([{ number: 3, user: "u", fields: parseBlock("result: r3") as never }])).toContain(
			"### T3",
		);
	});

	it("gives the narrative what index and lists leave, at least a fifth", () => {
		const cfg = { ...DEFAULT_CONFIG, statusMaxTokens: 8000 };
		expect(narrativeBudget(cfg, { index: [], rules: [], open: [], files: [] })).toBe(7700);
		const many = Array.from(
			{ length: 500 },
			(_, i) => `[T${i}] a fairly long index line about the leaf palette ${i}`,
		);
		expect(narrativeBudget(cfg, { index: many, rules: many, open: many, files: [] })).toBe(1700);
	});

	it("parses index and tags and ranks tag hits in search", () => {
		const f = parseBlock("result: x\nindex: palette wald chosen\ntags: Blattfarbe, DEMO_LEAFPAL");
		expect(f?.index).toEqual(["palette wald chosen"]);
		expect(f?.tags).toEqual(["Blattfarbe, DEMO_LEAFPAL"]);
		expect(systemPromptSection(DEFAULT_CONFIG)).toContain("tags: 3-6 search terms");
	});

	it("reads durations the way a user counts them", () => {
		expect(compactDuration(900)).toBe("900 ms");
		expect(compactDuration(4500)).toBe("4.5 s");
		expect(compactDuration(45_000)).toBe("45 s");
		expect(compactDuration(125_000)).toBe("2 m 5 s");
	});

	it("describes a stored compaction in one line", () => {
		const base = {
			version: 1 as const,
			outcome: "protocol" as const,
			startedAt: "2026-10-28T10:00:00.000Z",
			durationMs: 65_000,
			steps: [],
			notes: [],
		};
		expect(compactStatusLine({ ...base, condensedTurns: 4, detailTurns: 2, keptTurns: 3 })).toBe(
			"compaction in 1 m 5 s: 4 turns condensed, 2 in detail, 3 kept in full",
		);
		expect(compactStatusLine({ ...base, condensedTurns: 4, detailTurns: 2, keptTurns: 3, pending: 2 })).toContain(
			", 2 not folded yet",
		);
		expect(compactStatusLine({ ...base, outcome: "no_room" })).toBe("compaction in 1 m 5 s: no room – Pi summarizes");
		expect(compactStatusLine({ ...base, outcome: "failed" })).toBe("compaction in 1 m 5 s: failed – Pi summarizes");
	});

	it("shows the measured time of a compaction in the export", () => {
		const status: CompactEntryData = {
			version: 1,
			outcome: "protocol",
			startedAt: "2026-10-28T10:00:00.000Z",
			durationMs: 45_000,
			steps: [{ label: "turn 2: write missing protocol", state: "ok", ms: 1200 }],
			notes: [],
		};
		const branch: PlainEntry[] = [
			{ id: "u1", type: "message", message: { role: "user", content: "question" } },
			{ id: "s1", type: "custom", customType: COMPACT_ENTRY, data: status },
			{
				id: "k1",
				type: "compaction",
				summary: "S",
				firstKeptEntryId: "u1",
				tokensBefore: 900,
				details: { protokoll: true, version: 3, detailTurns: 1 },
			},
		];
		const out = diagnosticAppendix(branch, DEFAULT_CONFIG, false);
		expect(out).toContain("| 1 | protokoll | 45 s | 900 |");
	});
});

describe("the model of the extension's own requests", () => {
	it("is unset by default, so the session model keeps being used", () => {
		expect(DEFAULT_CONFIG.auxiliaryModel).toBe("");
	});

	it("takes a provider/model reference, and only splits at the first slash", () => {
		const warnings: string[] = [];
		const merged = mergeConfig(DEFAULT_CONFIG, { auxiliaryModel: "openai/gpt-4.1-mini" }, "t.json", warnings);
		expect(merged.auxiliaryModel).toBe("openai/gpt-4.1-mini");
		expect(warnings).toEqual([]);
		expect(parseModelRef("openai/google/gemini-pro")).toEqual({ provider: "openai", id: "google/gemini-pro" });
		for (const bad of ["", "gpt-4", "/only-id", "provider/", "  /x"]) expect(parseModelRef(bad)).toBeNull();
	});

	it("reports a malformed reference instead of applying it", () => {
		const warnings: string[] = [];
		const merged = mergeConfig(DEFAULT_CONFIG, { auxiliaryModel: "gpt-4" }, "t.json", warnings);
		expect(merged.auxiliaryModel).toBe("");
		expect(warnings.some((w) => w.includes('"auxiliaryModel"'))).toBe(true);
		const typed: string[] = [];
		expect(mergeConfig(DEFAULT_CONFIG, { auxiliaryModel: 7 }, "t.json", typed).auxiliaryModel).toBe("");
		expect(typed.length).toBe(1);
	});

	it("knows the provider that cannot serve a direct request", () => {
		expect(isUnsupportedModelCall({ provider: "cursor", api: "openai-completions" })).toBe(true);
		expect(isUnsupportedModelCall({ provider: "other", api: "cursor-sdk" })).toBe(true);
		expect(isUnsupportedModelCall({ provider: "openai", api: "openai-completions" })).toBe(false);
		expect(isUnsupportedModelCall({})).toBe(false);
	});
});
