#!/usr/bin/env node
// Minimal OpenAI-compatible chat endpoint for scripts/e2e.sh: every answer is a fixed text with a
// protocol block. Usage: stub-model.mjs <port> <request-log>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, log] = process.argv.slice(2);
const text =
	"Done.\n\n<protocol>\nresult: answered the test prompt\nindex: test prompt answered\ntags: e2e, stub\nopen: none\n</protocol>";
const chunk = (delta, finish) =>
	`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;

createServer((req, res) => {
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", () => {
		appendFileSync(log, `${body}\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk({ role: "assistant", content: text }));
		res.write(chunk({}, "stop"));
		res.end("data: [DONE]\n\n");
	});
}).listen(Number(port), "127.0.0.1");
