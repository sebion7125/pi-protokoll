# pi-protokoll

A [Pi](https://pi.dev) extension that makes very long sessions possible with local models:
the model writes a short protocol at the end of every turn, and compaction builds a bounded,
tiered summary from those protocols instead of re-reading and summarizing the whole history.

*Deutsche Fassung: [README.de.md](README.de.md)*

## Why

Pi's built-in compaction sends the old history to the model and waits while it writes a
summary. With a local model that is slow (minutes on a long session), and the summary is
written after the fact from an overfull context.

Here the expensive part happens while working: each final answer ends with a protocol block,
written while the model still has the full turn in view. At compaction time almost everything
is ready; code assembles the summary and the model only updates a short overview.

Measured in one session with Qwen3.x on a local OpenAI-compatible server (2× RTX 3090,
262k context window):

- 22 compactions over 118 turns, each about **213,000 → 35,000 tokens in about 30 s**
- resuming the session reads about 36,000–44,000 tokens
- every earlier turn stays reachable through tools

Practical example: [64kdemo](https://github.com/sebion7125/64kdemo), a procedural forest landscape in C and OpenGL, with screenshots, a camera flight and the story of how it came about. Its first ten sessions ran without the extension and kept ending in context poisoning; with the extension, from the tree system on, it stayed a single session, the one measured above.

## How it works

A *turn* is one agent run: your message with all tool rounds up to the final answer.
Messages you send while the model is working belong to the running turn.

1. **System prompt.** A fixed section asks the model to end every final answer with a
   `<protocol>` block: `result`, `decision`, `files`, `open`, `rule`, `revoke`, `index`, `tags`.
   The text never changes, so the server's prefix cache stays valid.
2. **Answer done.** The block is cut out of the answer and stored as a session entry, shown
   collapsed (`▸ protocol turn 7: …`). A block written early keeps the text after it in the answer;
   a tag quoted inside code or inside a sentence is left alone. The extension numbers the turns,
   not the model.
3. **Block missing.** The extension asks once more with the unchanged context plus a short
   instruction. The prompt starts like the one just run, so a prefix cache only reads the new
   tokens. Only the block is kept, not the exchange. If the model ignores the request, the block is written
   from the turn's transcript right away.
4. **Turn interrupted** (Esc, error, output limit). Before your next message goes out, the
   protocol of the interrupted turn is written: what was done, what is still open. Tool calls
   the model makes out of habit are answered with "tools unavailable" and not executed. If
   that fails, a second attempt works from the turn's transcript.
5. **Compaction.** Pi triggers it as usual. The summary has tiers, each with a hard limit:

   | Tier | Content | Limit |
   |---|---|---|
   | verbatim | the last turns as they are | `keepRecentTurns`, at most `keepRecentPercent` % of the window |
   | detail | the next older turns: **your message verbatim** + protocol; pinned turns in full; turns without protocol as a shortened transcript | `detailMaxTokens` |
   | status | everything older | `statusMaxTokens` |

   The **status** consists of:
   - an **index**, one line per older turn: the `index` line the model wrote with that
     turn. Code assembles it again at every compaction from the stored protocols, so it cannot
     drift. When it no longer fits, the oldest turns are grouped into range lines built from
     their `tags` (`[T1–T20] leaf palette (T14, T16); DEMO_LEAFPAL (T14); impostor atlas (T18–T19)`);
   - the active **rules** (`rule` minus `revoke`), **open items** and **files touched**, all
     taken from the protocols by code;
   - a **state of work**, the only part the model rewrites: it gets the previous state and the
     protocols of the turns now leaving the detail tier. Long backlogs are folded in chunks of
     `foldChunkTokens`.

   A **review** step lets the model clean up rules and open items. It can only choose entries by
   number (`RULES: R1, R4`), so it cannot reword or invent anything.

   If anything fails, or the result would not free enough space, the extension steps back and
   Pi compacts in its own way. The chat never blocks.

6. **Lookup tools** for the model:
   - `protocol_read("12, 40-44")` returns the full stored protocols plus your message,
   - `protocol_search(query)` finds turns by keywords (tags count double),
   - `protocol_turn(n)` returns the original transcript of one turn.

Progress is shown above the editor during compaction and backfills. Afterwards a widget shows
the new context size; it stays until the next message, because Pi redraws the chat after
compaction.

Every compaction additionally stores its own status entry (`protokoll-compact`): how it ended,
how long it took in total, the time of every step and the notification lines of the pass. The
duration is therefore readable long after the widget is gone – in the console and in anything
that renders session entries, a web view for example. `/protokoll export` lists the time of
every compaction.

While a pass runs, every step is also published on Pi's shared extension bus (channel
`pi-protokoll:progress`, see `ProgressEvent` in `src/core.ts`), so another extension can show the
running steps live. Each report carries the whole run: for every step its state, its own time, how
many characters the model has sent and whether it is thinking or writing — the same status the
console widget shows. Those lines are never stored in the session — one status entry per pass stays
the record.

## Install

```bash
pi install git:github.com/sebion7125/pi-protokoll
```

or from a local checkout:

```bash
pi install ./pi-protokoll
```

Restart Pi (or `/reload`) and run `/protokoll status`.

Configuration is optional. Copy `protokoll.example.json` to `~/.pi/agent/protokoll.json` and
adjust it; a project can override values in `<project>/.pi/protokoll.json`.

**Upgrading from the manual install** (`~/.pi/agent/extensions/protokoll/`): delete that folder,
otherwise the extension loads twice. Your `protokoll.json` and all session data stay as they are.

## Requirements and scope

- Pi ≥ 1.1. Used daily with 1.1.0; typechecked, unit-tested and run end to end (stub model) with 1.4.0.
- Built and tested with **local models behind an OpenAI-compatible server** (Qwen3.x).
  Thinking levels for the extension's own requests are written directly into the request
  (`reasoning_effort`, `chat_template_kwargs.enable_thinking`). This works for that kind of
  server only.
- Other providers and models are **untested**. The extension should work with any model that
  follows the block format, but cache behaviour and thinking control may differ.

## Commands

| Command | Effect |
|---|---|
| `/protokoll` or `/protokoll status` | state, turns, protocols, pinned turns, coverage of the state of work, compaction count |
| `/protokoll show` | preview of the summary (no model call; turns not yet folded appear as single lines) |
| `/protokoll export [file]` | the same as a Markdown file, plus a diagnostics part: effective configuration, all compactions, the stored state with reviewed rules, a table of all turns and all protocols in full |
| `/protokoll pin N` / `unpin N` | keep turn N verbatim at compaction |
| `/protokoll on` / `off` | enable or disable for this session |
| `/protokoll reload` | reread `protokoll.json` |
| `/protokoll rebuild` | rebuild the state of work from all protocols at the next compaction instead of updating it (against drift; takes longer) |
| `/protokoll repair` | bring an older session up to date: turns without protocol get one from their transcript, protocols without `index`/`tags` get both (8 turns per request), then compacts with a rebuild. Never replaces what the model wrote itself; running it again continues where it stopped |

The German command names of earlier versions (`zeigen`, `anheften`, `lösen`, `an`, `aus`,
`neu-laden`, `stand-neu`, `heilen`) still work.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch (per session: `/protokoll on\|off`) |
| `tag` | `"protocol"` | name of the block |
| `maxWords` | `250` | length guide for the block in the system prompt (changing it invalidates the prefix cache once) |
| `strip` | `true` | remove the block from the stored answer |
| `followUp` | `true` | ask for a missing block right away |
| `followUpReasoning` | `"off"` | thinking level of requests **without** chat context (transcript backfill, state of work, index repair). Requests that repeat the chat context always use the chat's level, otherwise the prefix cache misses |
| `consolidateReasoning` | `"low"` | thinking level of the review; comparing each rule with the later ones works much better with some thinking |
| `followUpMaxTokens` | `16384` | output limit of requests with chat context; thinking counts against it |
| `followUpTimeoutMs` | `600000` | time limit per request with chat context |
| `auxiliaryModel` | `""` | model for the extension's own requests as `"provider/model"`; empty uses the session model. Never changes the model of the normal chat |
| `compaction` | `"protocol"` | `"default"` leaves compaction entirely to Pi |
| `consolidate` | `true` | run the review of rules and open items |
| `keepRecentTurns` | `3` | keep this many last turns verbatim … |
| `keepRecentPercent` | `10` | … but at most this share of the context window |
| `keepUserMessages` | `true` | your messages verbatim in the detail tier |
| `userMessageMaxChars` | `4000` | longer messages (pasted logs) are shortened there |
| `lookupTool` | `true` | offer `protocol_turn` and `protocol_read` |
| `lookupMaxTokens` | `8000` | output limit of those tools |
| `pinnedMaxTokens` | `8000` | size limit per pinned turn |
| `digestMaxTokens` | `1500` | size limit per turn without protocol |
| `detailMaxTokens` | `30000` | hard limit of the detail tier |
| `statusMaxTokens` | `8000` | hard limit of the status (at least 800): index ≤ 35 %, rules ≤ 25 %, open items ≤ 15 %, files ≤ 5 %; the state of work gets what they leave, at least 20 %. Too long a state is shortened twice evenly, then cut in the middle, never at the end |
| `foldChunkTokens` | `12000` | input size per call when folding turns into the state |
| `searchTool` | `true` | offer `protocol_search` |
| `searchMaxResults` | `10` | maximum hits |
| `backfill` | `true` | write protocols of interrupted turns |
| `backfillMaxPerCompaction` | `8` | at most this many backfills per compaction |
| `backfillTranscriptTokens` | `12000` | transcript size per backfill (at least 2000) |
| `backfillMaxTokens` | `4096` | output limit per backfill |

The whole summary is at most about `detailMaxTokens + statusMaxTokens + 400` tokens, about
38,000 with the defaults.

**When** to compact is still Pi's decision: `context > contextWindow − compaction.reserveTokens`
(`~/.pi/agent/settings.json`). Make sure `contextWindow` in `models.json` matches your server.

### Auxiliary model

`auxiliaryModel` applies to the extension's own requests only: follow-up, transcript backfill,
folding the state of work, the review of rules and `repair`. The model of your chat stays exactly as
it is.

```json
{
  "auxiliaryModel": "openai/gpt-4.1-mini"
}
```

Pi's Cursor path has no session mapping for the kind of direct request the extension makes, so
asking a Cursor model directly does not work. When your session model is a Cursor model
(`provider: "cursor"` or `api: "cursor-sdk"`) and no auxiliary model is configured, the extension
sends no request at all: it says so once per session, treats the protocol as missing and leaves
compaction and everything else working. Set `auxiliaryModel` to a model from another provider to get
the follow-up, backfill and review back. A malformed or unknown reference is reported and the request
is skipped – it never silently falls back to the session model. Note that a request which repeats the
chat context has to fit the auxiliary model's context window.

## Development

```bash
npm install
npm run check   # typecheck, lint, tests
npm run e2e     # real Pi CLI from node_modules + stub model: install, nine turns, compaction
```

The tests (`tests/`) drive the extension through a stand-in for Pi's extension API with a
scripted model. They check the wiring and the pure logic, not Pi itself.

## Known limits

- The model must write the block. Qwen3.x forgets it in roughly half of the long tool-heavy
  turns; the follow-up request fixes that at the cost of a few seconds.
- `/compact <instructions>` is not yet passed on to the state of work.
- The state of work is the one part the model rewrites, so it can drift; the index, the lists
  and the stored protocols cannot. `/protokoll rebuild` rebuilds it from scratch.

## License

MIT
