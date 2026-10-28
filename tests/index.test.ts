/**
 * Drives the extension through a stand-in for Pi's ExtensionAPI: events are fired by hand,
 * the model is a scripted stub. Checks the wiring, not Pi itself.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	COMPACT_ENTRY,
	type CompactEntryData,
	collectProtocols,
	collectTurns,
	type PlainEntry,
	PROGRESS_CHANNEL,
	type ProgressEvent,
	type ProtocolEntryData,
	tok,
} from "../src/core.ts";
import protokoll, { forceThinkingLevel, Progress } from "../src/index.ts";

type Handler = (event: any, ctx: any) => any;

function harness(modelAnswers: string[] = [], config?: Record<string, unknown>) {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-agent-"));
	// the test window is tiny (10 000 tokens), so the status gets a matching budget
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR, "protokoll.json"),
		JSON.stringify({ statusMaxTokens: 1500, ...(config ?? {}) }),
	);
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	let activeTools = ["read", "bash"];
	const branch: PlainEntry[] = [];
	/** models the registry can find by "provider/id", besides the session model */
	const models: Record<string, unknown>[] = [{ id: "m", provider: "test", contextWindow: 10_000 }];
	const notes: string[] = [];
	const requests: any[] = [];
	const widgets: (string[] | undefined)[] = [];
	/** what the extension puts on the shared bus while a run is going */
	const bus: { channel: string; data: any }[] = [];
	let seq = 0;

	const pi: any = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		events: {
			emit: (channel: string, data: unknown) => bus.push({ channel, data }),
			on: () => () => {},
		},
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerMarkdownTransformer: () => {},
		registerEntryRenderer: () => {},
		getActiveTools: () => activeTools,
		getThinkingLevel: () => "medium",
		setActiveTools: (t: string[]) => {
			activeTools = t;
		},
		appendEntry: (customType: string, data: unknown) =>
			branch.push({ id: `c${++seq}`, type: "custom", customType, data }),
	};
	const ctx: any = {
		cwd: mkdtempSync(join(tmpdir(), "pi-cwd-")),
		hasUI: false,
		ui: {
			notify: (m: string) => notes.push(m),
			setStatus: () => {},
			setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
			editor: async () => undefined,
			confirm: async () => false,
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "s1",
			buildSessionProjection: () => ({
				messages: [
					{ role: "system", content: "S" },
					...branch.filter((e) => e.type === "message").map((e) => e.message),
				],
			}),
		},
		model: { id: "m", provider: "test", contextWindow: 10_000 },
		getContextUsage: () => ({ contextWindow: 10_000, tokens: 0, percent: 0 }),
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			streamSimple: (model: unknown, context: any, options: any) => {
				requests.push({ model, context, options });
				const text = modelAnswers.shift() ?? "";
				return {
					result: async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }),
				};
			},
		},
		signal: undefined,
	};
	protokoll(pi);
	const fire = async (name: string, event: any) => {
		let result: any;
		for (const h of handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	};
	const addUser = (text: string) => {
		const e: PlainEntry = { id: `u${++seq}`, type: "message", message: { role: "user", content: text } };
		branch.push(e);
		return e;
	};
	const addAssistant = (text: string) => {
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
		branch.push({ id: `a${++seq}`, type: "message", message });
		return message;
	};
	const settle = (last: any) =>
		fire("agent_before_settle", {
			outcome: "completed",
			entries: [],
			continue: false,
			context: {
				contextMessages: [last],
				llmMessages: [{ role: "system", content: "S" }, last],
				contextEntries: [],
				pendingMessages: [],
				canContinue: false,
			},
		});
	/** One full turn as Pi would run it; returns the protocol draft the extension proposed. */
	const turn = async (userText: string, answer: string) => {
		addUser(userText);
		const sections: Record<string, string> = {};
		await fire("before_agent_start", { systemPromptOptions: { sections } });
		let message: any = { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" };
		const replaced = await fire("message_end", { message });
		if (replaced?.message) message = replaced.message;
		branch.push({ id: `a${++seq}`, type: "message", message });
		const r = await settle(message);
		for (const d of r?.entries ?? []) branch.push({ id: `p${++seq}`, ...d });
		return { sections, message, draft: r?.entries?.[0]?.data as ProtocolEntryData | undefined };
	};
	return {
		pi,
		ctx,
		fire,
		branch,
		bus,
		models,
		tools,
		commands,
		notes,
		requests,
		widgets,
		turn,
		addUser,
		addAssistant,
		settle,
		activeTools: () => activeTools,
	};
}

describe("protokoll extension", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(async () => {
		h = harness();
		await h.fire("session_start", { reason: "startup" });
	});

	it("adds the prompt section and activates the lookup tool", async () => {
		const { sections } = await h.turn("hi", "Hello.\n<protocol>\nresult: greeted\n</protocol>");
		expect(sections.session_protocol).toContain("<protocol>");
		expect(h.activeTools()).toContain("protocol_turn");
	});

	it("strips the block and stores it", async () => {
		const { message, draft } = await h.turn(
			"build it",
			"Built.\n\n<protocol>\nresult: built\nopen: tests\n</protocol>",
		);
		expect(message.content[0].text).toBe("Built.");
		expect(draft?.source).toBe("inline");
		expect(draft?.fields?.result).toEqual(["built"]);
		expect(draft?.turn).toBe(1);
	});

	it("asks once with the unchanged context when the block is missing", async () => {
		h = harness(["<protocol>\nresult: answered later\n</protocol>"]);
		await h.fire("session_start", { reason: "startup" });
		const { draft } = await h.turn("q", "An answer without block.");
		expect(draft?.source).toBe("followup");
		expect(draft?.fields?.result).toEqual(["answered later"]);
		const req = h.requests[0];
		expect(req.context.messages[0]).toEqual({ role: "system", content: "S" }); // prefix unchanged
		expect(req.context.messages.at(-1).role).toBe("user");
		// same thinking level as the chat and no payload change: the prompt prefix must stay identical
		expect(req.options.reasoning).toBe("medium");
		expect(req.options.onPayload).toBeUndefined();
	});

	it("records a missing protocol when the follow-up fails too", async () => {
		h = harness(["no idea"]);
		await h.fire("session_start", { reason: "startup" });
		const { draft } = await h.turn("q", "answer");
		expect(draft?.source).toBe("missing");
		expect(h.notes.some((n) => n.includes("has no protocol"))).toBe(true);
	});

	it("writes the block from the transcript when the follow-up is ignored", async () => {
		h = harness(["I will continue with the task now", "<protocol>\nresult: fog added\n</protocol>"]);
		await h.fire("session_start", { reason: "startup" });
		const { draft } = await h.turn("please add fog", "answer");
		expect(draft?.source).toBe("backfill");
		expect(draft?.fields?.result).toEqual(["fog added"]);
		const transcriptPrompt = h.requests[1].context.messages[0].content as string;
		expect(transcriptPrompt).toContain("<transcript>");
		expect(transcriptPrompt).toContain("please add fog");
	});

	it("does nothing after /protokoll aus", async () => {
		await h.commands.get("protokoll").handler("aus", h.ctx);
		const { sections, message, draft } = await h.turn("q", "A\n<protocol>result: x</protocol>");
		expect(sections.session_protocol).toBeUndefined();
		expect(message.content[0].text).toContain("<protocol>");
		expect(draft).toBeUndefined();
		expect(h.activeTools()).not.toContain("protocol_turn");
	});

	it("builds the compaction summary from protocols and keeps the latest turns", async () => {
		for (let i = 1; i <= 6; i++)
			await h.turn(`question ${i}`, `answer ${i}\n<protocol>\nresult: r${i}\nrule: rule ${i}\n</protocol>`);
		const branch = h.branch;
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: branch[branch.length - 3].id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
				messagesToSummarize: [],
				turnPrefixMessages: [],
				fileOps: {},
			},
			branchEntries: branch,
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
		const c = r?.compaction;
		expect(c).toBeDefined();
		expect(c.details).toMatchObject({ protokoll: true, condensedTurns: 3, keptTurns: 3 });
		expect(c.summary).toContain("User: question 1");
		expect(c.summary).toContain("Result: r3");
		expect(c.summary).not.toContain("question 4");
		const firstKept = branch.find((e) => e.id === c.firstKeptEntryId);
		expect(firstKept?.message?.content).toBe("question 4");
	});

	it("drops a review that invents items", async () => {
		h = harness(["RULES:\n- deploy on friday\nOPEN:\n- none\nNOTES:\n- none"]);
		await h.fire("session_start", { reason: "startup" });
		for (let i = 1; i <= 4; i++)
			await h.turn(`q${i}`, `a${i}\n<protocol>\nresult: r${i}\nrule: keep tuples\n</protocol>`);
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: h.branch.at(-3)!.id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: h.branch,
			signal: new AbortController().signal,
		});
		expect(r.compaction.summary).toContain("- keep tuples");
		expect(r.compaction.summary).not.toContain("friday");
	});

	it("returns the original turn through the tool", async () => {
		await h.turn("first question", "first answer\n<protocol>result: x</protocol>");
		await h.turn("second", "second answer\n<protocol>result: y</protocol>");
		const res = await h.tools.get("protocol_turn").execute("id", { turn: 1 }, undefined, undefined, h.ctx);
		expect(res.content[0].text).toContain("first question");
		expect(res.content[0].text).toContain("first answer");
		await expect(
			h.tools.get("protocol_turn").execute("id", { turn: 9 }, undefined, undefined, h.ctx),
		).rejects.toThrow(/does not exist/);
	});

	it("pins a turn", async () => {
		await h.turn("pin me", "ok\n<protocol>result: x</protocol>");
		await h.commands.get("protokoll").handler("anheften 1", h.ctx);
		expect(h.branch.at(-1)?.customType).toBe("protokoll-pin");
	});

	const compact = (hh: ReturnType<typeof harness>, keepLast = 3) => {
		const turnsStart = hh.branch.filter((e) => e.message?.role === "user").at(-keepLast);
		return hh.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: turnsStart!.id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: hh.branch,
			signal: new AbortController().signal,
		});
	};
	const tiered = { detailMaxTokens: 200, statusMaxTokens: 1500, consolidate: false };

	it("folds older turns into the state of work and stores it", async () => {
		h = harness(["STATE A: terrain exists [T2]."], tiered);
		await h.fire("session_start", { reason: "startup" });
		for (let i = 1; i <= 30; i++)
			await h.turn(`question ${i}`, `answer ${i}\n<protocol>\nresult: r${i}\nfiles: f${i}.c\n</protocol>`);
		const r = await compact(h);
		const c = r.compaction;
		expect(c.details).toMatchObject({ protokoll: true, version: 3 });
		expect(c.details.status.narrative).toBe("STATE A: terrain exists [T2].");
		expect(c.details.status.folded.startsWith("1-")).toBe(true);
		expect(c.summary).toContain("STATE A");
		expect(c.summary).toContain("## Recent turns in detail");
		expect(c.summary).toContain("f27.c [T27]");
		expect(h.requests[0].context.messages[0].content).toContain("[T1] User: question 1");
		expect(tok(c.summary)).toBeLessThanOrEqual(400 + 200 + 1500);
	});

	it("reuses the stored state and folds only new turns next time", async () => {
		h = harness(["STATE A", "STATE B"], tiered);
		await h.fire("session_start", { reason: "startup" });
		for (let i = 1; i <= 30; i++)
			await h.turn(`question ${i}`, `answer ${i}\n<protocol>\nresult: r${i}\n</protocol>`);
		const first = (await compact(h)).compaction;
		const firstKept = h.branch.findIndex((e) => e.id === first.firstKeptEntryId);
		h.branch.push({
			id: "cmp1",
			type: "compaction",
			summary: first.summary,
			firstKeptEntryId: first.firstKeptEntryId,
			details: first.details,
		});
		expect(firstKept).toBeGreaterThan(0);
		for (let i = 31; i <= 45; i++)
			await h.turn(`question ${i}`, `answer ${i}\n<protocol>\nresult: r${i}\n</protocol>`);
		const second = (await compact(h)).compaction;
		const prompt = h.requests[1].context.messages[0].content as string;
		expect(prompt).toContain("<current_state>\nSTATE A");
		expect(prompt).not.toContain("[T1] User");
		expect(second.details.status.narrative).toBe("STATE B");
		expect(second.summary).toContain("STATE B");
	});

	it("keeps unfolded turns as single lines when the model gives nothing back", async () => {
		h = harness([], tiered);
		await h.fire("session_start", { reason: "startup" });
		for (let i = 1; i <= 30; i++)
			await h.turn(`question ${i}`, `answer ${i}\n<protocol>\nresult: r${i}\n</protocol>`);
		const c = (await compact(h)).compaction;
		expect(c.details.status.folded).toBe("");
		expect(c.summary).toContain("## Index of older turns");
		expect(c.summary).toContain("[T1] r1");
		expect(h.notes.some((n) => n.includes("not folded yet"))).toBe(true);
	});

	it("finds earlier turns with protocol_search", async () => {
		await h.turn("please add shadow mapping", "done\n<protocol>\nresult: shadow mapping added\n</protocol>");
		await h.turn("now fog", "done\n<protocol>\nresult: fog added\n</protocol>");
		const res = await h.tools.get("protocol_search").execute("id", { query: "shadow" }, undefined, undefined, h.ctx);
		expect(res.content[0].text).toContain("Turn 1");
		expect(res.content[0].text).not.toContain("Turn 2");
		await h.commands.get("protokoll").handler("aus", h.ctx);
		expect(h.activeTools()).not.toContain("protocol_search");
		expect(h.activeTools()).toEqual(["read", "bash"]);
	});

	// ------------------------------------------------------------------ v3

	/** A turn that stopped early: tool work, then an aborted answer, no settle and no protocol. */
	const interrupted = (hh: ReturnType<typeof harness>, text: string) => {
		hh.addUser(text);
		hh.branch.push({
			id: `x${hh.branch.length}`,
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "t", name: "edit", arguments: { path: `${hh.ctx.cwd}/src/scene.h` } }],
			},
		});
		hh.branch.push({
			id: `y${hh.branch.length}`,
			type: "message",
			message: { role: "toolResult", toolName: "edit", content: [{ type: "text", text: "ok" }] },
		});
		hh.branch.push({
			id: `z${hh.branch.length}`,
			type: "message",
			message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Now the sha" }] },
		});
	};

	it("writes the protocol of an interrupted turn when the session continues", async () => {
		h = harness(["<protocol>\nresult: caps raised, scene.h edited\nopen: shader blend\n</protocol>"]);
		await h.fire("session_start", { reason: "startup" });
		await h.turn("plan it", "planned\n<protocol>result: plan</protocol>");
		interrupted(h, "do it");
		h.ctx.hasUI = true;
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		const req = h.requests[0];
		expect(req.context.messages[0]).toEqual({ role: "system", content: "S" }); // same prefix as the last request
		expect(req.context.messages.at(-1).content).toContain("interrupted");
		const entry = h.branch.at(-1);
		expect(entry?.customType).toBe("protokoll");
		expect((entry?.data as ProtocolEntryData).source).toBe("backfill");
		expect((entry?.data as ProtocolEntryData).turn).toBe(2);
		expect(h.widgets.some((w) => w?.some((l) => l.includes("turn 2 was interrupted")))).toBe(true);
		expect(h.widgets.at(-1)).toBeUndefined(); // cleared
		// nothing to do the next time
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.requests.length).toBe(1);
	});

	it("rejects a backfill cut off by the output limit", async () => {
		h = harness(["<protocol>\nresult: Ran PIL analysis of /tmp/q_A.ppm and /"]);
		await h.fire("session_start", { reason: "startup" });
		const stream = h.ctx.modelRegistry.streamSimple;
		h.ctx.modelRegistry.streamSimple = (...args: any[]) => {
			const s = stream(...args);
			const result = s.result;
			return { ...s, result: async () => ({ ...(await result()), stopReason: "length" }) };
		};
		interrupted(h, "do it");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect((h.branch.at(-1)?.data as ProtocolEntryData).source).toBe("missing");
	});

	it("asks only once when the backfill of an interrupted turn fails", async () => {
		h = harness(["sorry, no block", "still no block"]);
		await h.fire("session_start", { reason: "startup" });
		interrupted(h, "do it");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect((h.branch.at(-1)?.data as ProtocolEntryData).source).toBe("missing");
		expect(h.requests.length).toBe(2); // with the chat context, then from the transcript
		expect(h.notes.at(-1)).toContain("the answer contained no block");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.requests.length).toBe(2);
	});

	it("answers a misplaced tool call with 'no tools now' and asks again on the same prefix", async () => {
		h = harness();
		await h.fire("session_start", { reason: "startup" });
		const replies: any[] = [
			{
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" } }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "<protocol>\nresult: batch half done\n</protocol>" }], stopReason: "stop" },
		];
		h.ctx.modelRegistry.streamSimple = (_m: unknown, context: any, options: any) => {
			h.requests.push({ context, options });
			const r = replies.shift();
			return { result: async () => ({ role: "assistant", ...r }) };
		};
		interrupted(h, "process all files");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.requests.length).toBe(2);
		const first = h.requests[0].context.messages;
		const second = h.requests[1].context.messages;
		expect(second.slice(0, first.length)).toEqual(first); // same prefix
		const result = second.at(-1);
		expect(result.role).toBe("toolResult");
		expect(result.toolCallId).toBe("t1");
		expect(result.content[0].text).toContain("not available");
		expect((h.branch.at(-1)?.data as ProtocolEntryData).fields?.result).toEqual(["batch half done"]);
	});

	it("falls back to the transcript when the request with the chat context fails", async () => {
		h = harness(["", "<protocol>\nresult: from transcript\n</protocol>"]);
		await h.fire("session_start", { reason: "startup" });
		interrupted(h, "do it");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.requests[1].context.messages[0].content).toContain("transcript of turn 1");
		const d = h.branch.at(-1)?.data as ProtocolEntryData;
		expect(d.source).toBe("backfill");
		expect(d.fields?.result).toEqual(["from transcript"]);
	});

	it("leaves a finished turn alone when the session continues", async () => {
		await h.turn("q", "a\n<protocol>result: x</protocol>");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.requests.length).toBe(0);
	});

	it("backfills missing protocols during compaction and shows the progress", async () => {
		h = harness(["<protocol>\nresult: turn two from transcript\n</protocol>"], {
			consolidate: false,
			keepRecentTurns: 1,
		});
		await h.fire("session_start", { reason: "startup" });
		h.ctx.hasUI = true;
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		interrupted(h, "q2");
		await h.turn("q3", "a3\n<protocol>result: r3</protocol>");
		interrupted(h, "q4");
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: h.branch.filter((e) => e.message?.role === "user").at(-1)!.id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [...h.branch],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		// kept: turn 4 (the last); condensed 1-3; turn 2 lacked a protocol
		const c = r.compaction;
		expect(c).toBeDefined();
		expect(h.requests[0].context.messages[0].content).toContain("transcript of turn 2");
		// without the chat context: thinking switched off in the request itself
		const body = h.requests[0].options.onPayload({ m: 1 }, { api: "openai-completions" });
		expect(body).toMatchObject({ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
		expect(c.summary).toContain("Result: turn two from transcript");
		expect(h.requests.length).toBe(1); // turn 4 is kept in full, it gets its protocol when the session continues
		expect(c.summary).toContain("src/scene.h");
		expect(h.branch.filter((e) => (e.data as ProtocolEntryData)?.source === "backfill").length).toBe(1);
		expect(h.notes.some((n) => n.includes("1 protocols written afterwards"))).toBe(true);
		const shown = h.widgets.flatMap((w) => w ?? []);
		expect(shown.some((l) => l.startsWith("protokoll compaction"))).toBe(true);
		expect(shown.some((l) => l.includes("✓ turn 2: write missing protocol"))).toBe(true);
		expect(h.widgets.at(-1)).toBeUndefined();
	});

	it("stores what the compaction did and how long each step took", async () => {
		h = harness(["<protocol>\nresult: turn two from transcript\n</protocol>"], {
			consolidate: false,
			keepRecentTurns: 1,
		});
		await h.fire("session_start", { reason: "startup" });
		h.ctx.hasUI = true;
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		interrupted(h, "q2");
		await h.turn("q3", "a3\n<protocol>result: r3</protocol>");
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: h.branch.filter((e) => e.message?.role === "user").at(-1)!.id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [...h.branch],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		// the pass talks to other extensions over the bus, without storing those lines
		const lines = h.bus.filter((e) => e.channel === PROGRESS_CHANNEL);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every((l) => (l.data as ProgressEvent).run === "compaction")).toBe(true);
		expect(lines.every((l) => (l.data as ProgressEvent).session === "s1")).toBe(true);
		expect(lines.some((l) => (l.data as ProgressEvent).state === "run")).toBe(true);
		expect((lines.at(-1)!.data as ProgressEvent).closed).toBe(true);
		const stored = h.branch.filter((e) => e.customType === COMPACT_ENTRY);
		expect(stored.length).toBe(1);
		const d = stored[0].data as CompactEntryData;
		expect(d.version).toBe(1);
		expect(d.outcome).toBe("protocol");
		expect(d.tokensBefore).toBe(9000);
		// the live lines cover exactly the steps the entry stores
		expect(Math.max(...lines.map((l) => (l.data as ProgressEvent).steps))).toBe(d.steps.length);
		expect((lines.at(-1)!.data as ProgressEvent).lines.map((l) => l.label)).toEqual(d.steps.map((s) => s.label));
		// the entry says the same as the compaction it produced
		const wrote = r.compaction.details as {
			condensedTurns: number;
			detailTurns: number;
			keptTurns: number;
			missingTurns: number;
		};
		expect(wrote.condensedTurns).toBeGreaterThan(0);
		expect(d.condensedTurns).toBe(wrote.condensedTurns);
		expect(d.detailTurns).toBe(wrote.detailTurns);
		expect(d.keptTurns).toBe(wrote.keptTurns);
		expect(d.missingTurns).toBe(wrote.missingTurns);
		expect(d.backfilled).toBe(1);
		expect(d.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(d.durationMs).toBeGreaterThanOrEqual(0);
		// every step of the widget survives, with its own time
		const step = d.steps.find((s) => s.label === "turn 2: write missing protocol");
		expect(step?.state).toBe("ok");
		expect(step?.ms).toBeGreaterThanOrEqual(0);
		expect(d.notes.some((n) => n.includes("turns condensed"))).toBe(true);
	});

	it("stores the failed pass when Pi has to summarize itself", async () => {
		h = harness([], { consolidate: false, statusMaxTokens: 5000 });
		await h.fire("session_start", { reason: "startup" });
		for (let i = 1; i <= 4; i++) await h.turn(`q${i}`, `a${i}\n<protocol>result: r${i}</protocol>`);
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: h.branch.at(-3)!.id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [...h.branch],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		expect(r).toBeUndefined();
		const d = h.branch.find((e) => e.customType === COMPACT_ENTRY)?.data as CompactEntryData;
		expect(d.outcome).toBe("no_room");
		expect(d.notes.some((n) => n.includes("Pi summarizes itself"))).toBe(true);
		expect(d.steps.length).toBe(0);
	});

	it("leaves no status entry when the pass never started", async () => {
		await h.turn("q", "a\n<protocol>result: x</protocol>");
		await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: "x",
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		expect(h.branch.some((e) => e.customType === COMPACT_ENTRY)).toBe(false);
	});

	it("stores the protocol of an aborted last turn when compaction cuts inside it", async () => {
		h = harness(["<protocol>\nresult: half done\nopen: rest\n</protocol>"], {
			consolidate: false,
			keepRecentPercent: 0,
		});
		await h.fire("session_start", { reason: "startup" });
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		interrupted(h, "mach weiter"); // ends with stopReason "aborted"
		const cut = h.branch.at(-2)!;
		await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: cut.id,
				isSplitTurn: true,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [...h.branch],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		expect(h.requests[0].context.messages.at(-1).content).toContain("interrupted");
		expect(h.branch.some((e) => (e.data as ProtocolEntryData)?.source === "backfill")).toBe(true);
		// the next prompt does not ask again
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.requests.length).toBe(1);
	});

	it("records the progress of the turn in progress without storing it", async () => {
		h = harness(["<protocol>\nresult: S1 done\nopen: S2 bending\n</protocol>"], {
			consolidate: false,
			keepRecentPercent: 0, // the last turn does not fit whole, so Pi cuts inside it
		});
		await h.fire("session_start", { reason: "startup" });
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		interrupted(h, "mach weiter");
		h.branch.pop(); // still running: no aborted answer at the end
		const cut = h.branch.at(-2)!; // inside turn 2
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: cut.id,
				isSplitTurn: true,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [...h.branch],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		expect(h.requests[0].context.messages.at(-1).content).toContain("still working");
		expect(r.compaction.summary).toContain("Progress so far");
		expect(r.compaction.summary).toContain("Still to do: S2 bending");
		expect(h.branch.some((e) => (e.data as ProtocolEntryData)?.source === "backfill")).toBe(false);
	});

	it("writes one protocol for a run with steering messages", async () => {
		const first = h.addUser("build trees");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		h.branch.push({
			id: "t1",
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }],
			},
		});
		h.branch.push({ id: "r1", type: "message", message: { role: "toolResult", toolName: "bash", content: "ok" } });
		h.addUser("leaves are red"); // steering: no before_agent_start
		let message: any = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "fixed\n<protocol>result: trees and leaves fixed</protocol>" }],
		};
		const replaced = await h.fire("message_end", { message });
		if (replaced?.message) message = replaced.message;
		h.branch.push({ id: "a9", type: "message", message });
		const r = await h.settle(message);
		expect(r.entries).toHaveLength(1);
		expect(r.entries[0].data.userEntryId).toBe(first.id);
		expect(r.entries[0].data.turn).toBe(1);
		expect(h.requests.length).toBe(0);
	});

	it("keeps the blocks of two turns in one run apart (queued follow-up message)", async () => {
		const first = h.addUser("one");
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		let m1: any = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "a\n<protocol>result: first</protocol>" }],
		};
		m1 = (await h.fire("message_end", { message: m1 }))?.message ?? m1;
		h.branch.push({ id: "a1x", type: "message", message: m1 });
		const second = h.addUser("two"); // follow-up queued while streaming: same run, new turn
		let m2: any = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "b\n<protocol>result: second</protocol>" }],
		};
		m2 = (await h.fire("message_end", { message: m2 }))?.message ?? m2;
		h.branch.push({ id: "a2x", type: "message", message: m2 });
		const r = await h.settle(m2);
		const byId = Object.fromEntries(r.entries.map((e: any) => [e.data.userEntryId, e.data.fields.result[0]]));
		expect(byId).toEqual({ [first.id]: "first", [second.id]: "second" });
	});

	it("writes a chosen thinking level into OpenAI-compatible requests", () => {
		expect(forceThinkingLevel({ m: 1 }, { api: "openai-completions" }, "low")).toEqual({
			m: 1,
			reasoning_effort: "low",
		});
	});

	it("reports the context size after a compaction", async () => {
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		await h.fire("session_compact", {
			compactionEntry: { summary: "x".repeat(3500), tokensBefore: 213621 },
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});
		const note = h.notes.at(-1) ?? "";
		expect(note).toContain("context after compaction");
		expect(note).toContain("before 213,621");
		expect(note).toContain("summary ≈ 875");
	});

	it("counts compactions in the status", async () => {
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		h.branch.push({ id: "k1", type: "compaction", summary: "s", details: { protokoll: true } } as PlainEntry);
		h.branch.push({ id: "k2", type: "compaction", summary: "s", tokensBefore: 213621 } as PlainEntry);
		await h.commands.get("protokoll").handler("status", h.ctx);
		expect(h.notes.at(-1)).toContain("compacted 2× (1 protokoll, 1 Pi)");
		expect(h.notes.at(-1)).toContain("at 213,621 tokens");
	});

	it("shows the compaction result in a widget that survives Pi's redraw", async () => {
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		h.ctx.hasUI = true;
		await h.fire("session_compact", {
			compactionEntry: { summary: "x".repeat(400), tokensBefore: 100000 },
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		});
		const shown = h.widgets.at(-1) ?? [];
		expect(shown.some((l) => l.includes("context after compaction"))).toBe(true);
		await h.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		expect(h.widgets.at(-1)).toBeUndefined(); // cleared with the next prompt
	});

	it("starts from the reviewed rules of the last compaction instead of all protocols", async () => {
		h = harness(["STATE A", "RULES: R1\nOPEN: none\nNOTES:\n- none", "STATE B"], {
			detailMaxTokens: 200,
			statusMaxTokens: 1500,
		});
		await h.fire("session_start", { reason: "startup" });
		await h.turn("q1", "a1\n<protocol>\nresult: r1\nrule: rule one\nrule: decided to use tuples\n</protocol>");
		for (let i = 2; i <= 30; i++)
			await h.turn(`q${i}`, `a${i}\n<protocol>\nresult: r${i}\nrule: none new\n</protocol>`);
		const first = (await compact(h)).compaction;
		expect(first.details.status.rules).toEqual(["rule one"]);
		h.branch.push({
			id: "cmpR",
			type: "compaction",
			summary: first.summary,
			firstKeptEntryId: first.firstKeptEntryId,
			details: first.details,
		});
		for (let i = 31; i <= 45; i++) await h.turn(`q${i}`, `a${i}\n<protocol>\nresult: r${i}\n</protocol>`);
		const second = (await compact(h)).compaction;
		expect(second.summary).toContain("- rule one");
		expect(second.summary).not.toContain("decided to use tuples");
		expect(second.summary).not.toContain("none new");
	});

	it("rebuilds the state of work from all older protocols after /protokoll rebuild", async () => {
		h = harness(["STATE A", "STATE REBUILT"], { detailMaxTokens: 200, statusMaxTokens: 1500, consolidate: false });
		await h.fire("session_start", { reason: "startup" });
		for (let i = 1; i <= 30; i++) await h.turn(`q${i}`, `a${i}\n<protocol>\nresult: r${i}\n</protocol>`);
		const first = (await compact(h)).compaction;
		h.branch.push({
			id: "cmpS",
			type: "compaction",
			summary: first.summary,
			firstKeptEntryId: first.firstKeptEntryId,
			details: first.details,
		});
		await h.commands.get("protokoll").handler("rebuild", h.ctx);
		for (let i = 31; i <= 33; i++) await h.turn(`q${i}`, `a${i}\n<protocol>\nresult: r${i}\n</protocol>`);
		const second = (await compact(h)).compaction;
		const prompt = h.requests[1].context.messages[0].content as string;
		expect(prompt).toContain("(empty: this is the first part of the session)");
		expect(prompt).toContain("[T1] User: q1");
		expect(second.details.status.narrative).toBe("STATE REBUILT");
	});

	it("heals old protocols with /protokoll repair and compacts with a rebuilt state", async () => {
		h = harness([
			"<protocol>\nresult: written later\nindex: late one\ntags: late\n</protocol>",
			"T1\nindex: fog exp2 chosen\ntags: fog, Nebel\nT2\nindex: sky palette set\ntags: sky",
		]);
		await h.fire("session_start", { reason: "startup" });
		await h.turn("nebel bitte", "done\n<protocol>\nresult: fog added\n</protocol>");
		await h.turn("himmel", "ok\n<protocol>\nresult: sky\n</protocol>");
		h.addUser("third");
		h.addAssistant("did it without block");
		h.branch.push({
			id: "pm",
			type: "custom",
			customType: "protokoll",
			data: { version: 1, userEntryId: h.branch.at(-2)?.id, turn: 3, source: "missing" },
		});
		let compacted = 0;
		h.ctx.isIdle = () => true;
		h.ctx.waitForIdle = async () => {};
		h.ctx.compact = (o: any) => {
			compacted++;
			o.onError(new Error("Nothing to compact (session too small)"));
		};
		await h.commands.get("protokoll").handler("heilen", h.ctx); // German alias still accepted;
		const p = collectProtocols(h.branch);
		const ids = collectTurns(h.branch).map((t) => t.userEntryId);
		expect(p.get(ids[0])?.fields?.tags).toEqual(["fog, Nebel"]);
		expect(p.get(ids[1])?.fields?.index).toEqual(["sky palette set"]);
		expect(p.get(ids[2])?.fields?.result).toEqual(["written later"]);
		expect(h.branch.some((e) => e.customType === "protokoll-rebuild")).toBe(true);
		expect(compacted).toBe(1);
		expect(h.notes.at(-2)).toContain("1 protocols written, 2 turns given index and tags");
		expect(h.notes.at(-1)).toContain("rebuilt automatically at the next compaction");
	});

	it("keeps the progress widget within Pi's 10 lines", () => {
		const shown: string[][] = [];
		const bar = new Progress(
			{ hasUI: true, ui: { setWidget: (_k: string, l: string[]) => l && shown.push(l) } } as any,
			"T",
		);
		const steps = Array.from({ length: 20 }, (_, i) => bar.add(`step ${i + 1}`));
		for (const s of steps.slice(0, 12)) bar.finish(s, true);
		bar.start(steps[12]);
		const lines = shown.at(-1) ?? [];
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines[1]).toContain("10 done");
		expect(lines.some((l) => l.includes("▸ step 13"))).toBe(true);
		expect(lines.at(-1)).toContain("more");
		bar.close();
	});

	it("reports every step on the shared bus and closes the run", () => {
		const lines: ProgressEvent[] = [];
		const bar = new Progress({ hasUI: false, sessionManager: { getSessionId: () => "s9" } } as any, "T", (line) =>
			lines.push({ ...line, run: "compaction" }),
		);
		const first = bar.add("fold older turns");
		bar.start(first);
		expect(lines.at(-1)).toMatchObject({
			version: 1,
			session: "s9",
			title: "T",
			step: 1,
			steps: 1,
			label: "fold older turns",
			state: "run",
			closed: false,
		});
		// what the console widget shows while a step runs reaches the listener too
		expect(lines.at(-1)!.lines).toEqual([
			{ label: "fold older turns", state: "run", ms: expect.any(Number), chars: 0, thinking: false },
		]);
		bar.update(first, 1200, true);
		expect(lines.at(-1)!.lines).toEqual([
			{ label: "fold older turns", state: "run", ms: expect.any(Number), chars: 1200, thinking: true },
		]);
		bar.finish(first, true);
		expect(lines.at(-1)!.lines).toEqual([
			{ label: "fold older turns", state: "ok", ms: expect.any(Number), chars: 1200, thinking: true },
		]);
		expect(lines.at(-1)).toMatchObject({ state: "ok", label: "", closed: false });
		// a step that ends without having started still reports a time, one that never ran reports none
		const second = bar.add("write the summary");
		bar.finish(second, false, "interrupted");
		expect(lines.at(-1)!.lines[1]).toMatchObject({ label: "write the summary", state: "fail", note: "interrupted" });
		expect(lines.at(-1)!.lines[1]!.ms).toBeGreaterThanOrEqual(0);
		bar.add("report");
		expect(lines.at(-1)!.lines[2]).toMatchObject({ label: "report", state: "wait", ms: null });
		bar.close();
		expect(lines.at(-1)).toMatchObject({ closed: true });
		expect(lines.every((l) => l.ms >= 0)).toBe(true);
	});

	it("appends a diagnostic part to /protokoll export", async () => {
		await h.turn(
			"nebel bitte",
			"done\n<protocol>\nresult: fog added\nindex: fog exp2\ntags: fog, Nebel\n</protocol>",
		);
		const file = join(h.ctx.cwd, "x.md");
		await h.commands.get("protokoll").handler(`export ${file}`, h.ctx);
		const text = readFileSync(file, "utf8");
		expect(text).toContain("# Diagnostics");
		expect(text).toMatch(/\| 1 \| inline \| own \| stop \| 1 \| 0 \| nebel bitte \|/);
		expect(text).toContain("tags: fog, Nebel");
		expect(text).toContain('"maxWords"');
	});

	it("keeps using the session model when no auxiliaryModel is set", async () => {
		h = harness(["<protocol>\nresult: later\n</protocol>"]);
		await h.fire("session_start", { reason: "startup" });
		const { draft } = await h.turn("q", "answer without block");
		expect(draft?.source).toBe("followup");
		expect((h.requests[0].model as { id: string }).id).toBe("m");
	});

	it("sends every own request to the configured auxiliaryModel", async () => {
		h = harness(["<protocol>\nresult: from aux\n</protocol>"], { auxiliaryModel: "openai/mini" });
		await h.fire("session_start", { reason: "startup" });
		h.models.push({ id: "mini", provider: "openai", contextWindow: 30_000 });
		const { draft } = await h.turn("q", "answer without block");
		expect(draft?.source).toBe("followup");
		expect((h.requests[0].model as { id: string }).id).toBe("mini");
		// the other model has no chat cache to protect: its own thinking level is used, not the chat's
		expect(h.requests[0].options.reasoning).toBeUndefined();
		expect(h.requests[0].options.onPayload).toBeInstanceOf(Function);
	});

	it("never asks Cursor directly and says why, once per session", async () => {
		h = harness([]);
		await h.fire("session_start", { reason: "startup" });
		h.ctx.model = { id: "cursor-model", provider: "cursor", api: "cursor-sdk", contextWindow: 10_000 };
		const one = await h.turn("q1", "first answer");
		const two = await h.turn("q2", "second answer");
		expect(one.draft?.source).toBe("missing");
		expect(two.draft?.source).toBe("missing");
		expect(h.requests.length).toBe(0);
		const notices = h.notes.filter((n) => n.includes("auxiliaryModel"));
		expect(notices.length).toBe(1);
		expect(notices[0]).toContain("unavailable with Cursor");
	});

	it("writes the protocol through a non-Cursor auxiliaryModel while the chat runs on Cursor", async () => {
		h = harness(["<protocol>\nresult: from aux model\n</protocol>"], { auxiliaryModel: "openai/mini" });
		await h.fire("session_start", { reason: "startup" });
		h.ctx.model = { id: "cursor-model", provider: "cursor", api: "cursor-sdk", contextWindow: 10_000 };
		h.models.push({ id: "mini", provider: "openai", contextWindow: 30_000 });
		const { draft } = await h.turn("q", "answer without block");
		expect(draft?.source).toBe("followup");
		expect(draft?.fields?.result).toEqual(["from aux model"]);
		expect((h.requests[0].model as { id: string }).id).toBe("mini");
		expect(h.notes.some((n) => n.includes("auxiliaryModel"))).toBe(false);
	});

	it("blocks a Cursor auxiliaryModel the same way", async () => {
		h = harness([], { auxiliaryModel: "cursor/cheap" });
		await h.fire("session_start", { reason: "startup" });
		h.models.push({ id: "cheap", provider: "cursor", api: "cursor-sdk", contextWindow: 30_000 });
		const { draft } = await h.turn("q", "answer");
		expect(draft?.source).toBe("missing");
		expect(h.requests.length).toBe(0);
		expect(h.notes.filter((n) => n.includes("Cursor")).length).toBe(1);
	});

	it("skips an unknown auxiliaryModel instead of falling back to the session model", async () => {
		h = harness(["<protocol>\nresult: should not happen\n</protocol>"], { auxiliaryModel: "openai/not-registered" });
		await h.fire("session_start", { reason: "startup" });
		const { draft } = await h.turn("q", "answer");
		expect(draft?.source).toBe("missing");
		expect(h.requests.length).toBe(0);
		const notices = h.notes.filter((n) => n.includes("openai/not-registered"));
		expect(notices.length).toBe(1);
	});

	it("still reads and strips an inline block when the chat model is Cursor", async () => {
		h = harness([]);
		await h.fire("session_start", { reason: "startup" });
		h.ctx.model = { id: "cursor-model", provider: "cursor", api: "cursor-sdk", contextWindow: 10_000 };
		const { message, draft } = await h.turn("q", "Built.\n<protocol>\nresult: built\n</protocol>");
		expect(draft?.source).toBe("inline");
		expect(draft?.fields?.result).toEqual(["built"]);
		expect(message.content[0].text).toBe("Built.");
		expect(h.requests.length).toBe(0);
	});

	it("uses the same auxiliaryModel for the backfill during compaction", async () => {
		h = harness(["<protocol>\nresult: turn two from transcript\n</protocol>"], {
			consolidate: false,
			keepRecentTurns: 1,
			auxiliaryModel: "openai/mini",
		});
		await h.fire("session_start", { reason: "startup" });
		h.models.push({ id: "mini", provider: "openai", contextWindow: 30_000 });
		await h.turn("q1", "a1\n<protocol>result: r1</protocol>");
		interrupted(h, "q2");
		await h.turn("q3", "a3\n<protocol>result: r3</protocol>");
		const askedBefore = h.requests.length;
		const r = await h.fire("session_before_compact", {
			preparation: {
				firstKeptEntryId: h.branch.filter((e) => e.message?.role === "user").at(-1)!.id,
				isSplitTurn: false,
				tokensBefore: 9000,
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [...h.branch],
			reason: "threshold",
			signal: new AbortController().signal,
		});
		expect(r.compaction).toBeDefined();
		expect(h.requests.length).toBeGreaterThan(askedBefore);
		expect(h.requests.map((q) => (q.model as { id: string }).id)).toEqual(
			Array.from({ length: h.requests.length }, () => "mini"),
		);
	});

	it("picks up auxiliaryModel on /protokoll reload", async () => {
		h = harness(["<protocol>\nresult: after reload\n</protocol>"]);
		await h.fire("session_start", { reason: "startup" });
		h.models.push({ id: "mini", provider: "openai", contextWindow: 30_000 });
		writeFileSync(
			join(process.env.PI_CODING_AGENT_DIR ?? ".", "protokoll.json"),
			JSON.stringify({ auxiliaryModel: "openai/mini" }),
		);
		await h.commands.get("protokoll").handler("reload", h.ctx);
		const { draft } = await h.turn("q", "answer without block");
		expect(draft?.source).toBe("followup");
		expect((h.requests[0].model as { id: string }).id).toBe("mini");
	});

	it("returns full protocols with protocol_read", async () => {
		await h.turn(
			"please add fog",
			"done\n<protocol>\nresult: fog added\ndecision: exp2 falloff\nopen: tune density\n</protocol>",
		);
		await h.turn("next", "ok\n<protocol>result: y</protocol>");
		const res = await h.tools.get("protocol_read").execute("id", { turns: "1, 3-4" }, undefined, undefined, h.ctx);
		const text = res.content[0].text as string;
		expect(text).toContain("User: please add fog");
		expect(text).toContain("Decision: exp2 falloff");
		expect(text).toContain("Open then: tune density");
		expect(text).toContain("### Turn 3\n(does not exist");
		expect(h.activeTools()).toContain("protocol_read");
	});
});
