# Changelog

## Unreleased

- **The lookup tools (`protocol_turn`, `protocol_read`, `protocol_search`) are declared only once the session holds a compaction.** Before that every turn is still in the context and there is nothing to look up. A reported session (Qwen 3.8-27B) with a single message "hi" ran 35 rounds in which the model called `protocol_turn(1)`, `(2)`, `(3)` … and each result said the turn did not exist; the extension had written nothing, the loop was the tool calls alone. A compaction rewrites the context anyway, so declaring the tools then costs no extra cache. The "turn does not exist" result now says how many turns there are and tells the model not to try further numbers.
- **`stateOfWork: false`** switches the state of work off (default `true`). Without it there is no fold request at compaction – the slowest step, and the only text the model rewrites every time – and the `State of work` section is left out of the summary. The index takes the status budget the text would have had, so it keeps single lines for more turns before older ones are grouped. Earlier summaries written by Pi itself are not merged in this mode; switching back on folds the turns that left the detail tier in the meantime.
- **Afterwards-only mode** (`"inline": false`, default `true`). Nothing about the protocol goes into the system prompt – no section, no length note – so the model never sees the format while it works. After every final answer the extension sends one extra request: the unchanged chat context plus one instruction that carries the format itself, so a prefix cache reads only the new tokens. The follow-up is always on in this mode; the requests for interrupted turns and for compaction in the middle of a turn carry the format the same way. `/protokoll on|off` needs no switch notes in this mode. With `inline: true` all texts and requests are byte-identical to before, so existing sessions keep their prefix cache. For models that ignore or are confused by the inline instruction.
- The model is asked for 90 % of the state-of-work budget instead of 100 %; the hard limit stays what the settings say. It rarely hits a length target exactly, and a state that ends up slightly over was cut in the middle.

## 0.9.7 – 2026-10-31

- The system prompt section carries a fixed note about the length of a session. Models, Qwen3.x among them, sometimes invent a context fill level (`Context left: 12 %`, `Context exhausted`) and advise a fresh chat; nothing in Pi, in this extension or in any installed package prints such lines. The note states the facts instead of forbidding the guess: without a fill level given in the current turn the model has no information about the window, so it states none, never claims it was told to start a new session, and suggests a fresh session only on a concrete, verifiable reason – the user decides. The text is fixed from now on, so the prefix cache is invalidated once.
- **Switching inside a session keeps the prefix.** `/protokoll off` no longer removes the section or the tools: prompt and tool list stay byte for byte and one message at the current position withdraws the rules (`[pi-protokoll disabled] …`). The three `protocol_*` tools stay declared and answer `pi-protokoll is disabled`. `/protokoll on` re-applies with a short note, once per change, not per command.
- **A session that ran without the section keeps it out of the prefix.** Enabling brings the full rules once as a message (`[pi-protokoll enabled] The following protocol rules apply from here on:`) instead of patching the prompt; the status points at `/protokoll repair` for the older turns without protocols.
- **Escape hatch `/protokoll off --strip`**: the section really leaves the system prompt and the tools are unregistered, no withdrawal text is inserted, and the status says that the next request reads the whole context again (once). `/protokoll on` puts both back, with the same notice. The mode survives restarts (stored in the session state entry).
- **After a compaction the prompt matches the state.** Pi copies the branch's system message onto the compaction entry, so the section outlives the cut while a note can be cut away. At the first settle boundary after a compaction the extension retires notes that contradict the state (`context_edit` with an empty replacement); when a needed withdrawal was cut away, the section leaves the prompt instead of leaving the model with rules nobody withdrew.
- README (de and en) documents both switch modes and the open points: following a withdrawal is model-dependent, the context rule assumes pi-protokoll does the compaction, and a fill level another extension hands over in the current turn is deliberately not denied.

## 0.9.6 – 2026-10-29

- Where the block is looked for is now decided deliberately instead of by guesswork, so an answer that quotes the tag no longer loses its text:
  - tags inside fenced code blocks and inline code spans are examples and are ignored by both extraction and display;
  - a block that closes the answer wins; if a block sits earlier in the answer, the text after it stays in the answer;
  - an unclosed tag counts as a block only when it opens a line and is followed by protocol keys (the model stopped early); a tag in the middle of a sentence is prose;
  - while streaming, a block is hidden only when it opens a line, so prose after a quoted tag stays visible;
  - a body without a single known key is no longer stored, and a reply without a block is no longer parsed as fields – the protocol is recorded as missing and requested instead.

## 0.9.5 – 2026-10-29

- Pi's Cursor path has no session mapping for the direct requests this extension makes. Such a model (`provider: "cursor"` or `api: "cursor-sdk"`) is therefore never asked directly: one understandable notice per session and cause, the protocol is recorded as missing, and compaction, backfill and the rest continue without blocked retries. Blocks the model wrote inline are still recognised, stored and stripped.
- New configuration key `auxiliaryModel` (`"provider/model"`, default empty): the model for **the extension's own requests** – follow-up, transcript backfill, folding the state of work, rule review and `repair`. The model of the normal chat is untouched. An unknown or malformed reference is reported and the request skipped, never silently replaced by the session model. `/protokoll reload` picks it up.

## 0.9.4 – 2026-10-29

- The bus report of a running pass now carries every step, not only the current one: state, the step's own time, how many characters the model has sent and whether it is thinking or writing. A web view shows the same status the console widget shows.

## 0.9.3 – 2026-10-29

- While a compaction (or backfill) pass runs, every step is published on Pi's shared extension bus (`pi.events`, channel `pi-protokoll:progress`) with its label, state and the elapsed time. pi-webapp shows these lines in the browser. Nothing is stored from them: the single `protokoll-compact` entry per pass stays the record.

## 0.9.2 – 2026-10-28

- Every compaction stores a status entry (`protokoll-compact`): how it ended, the total time, the time of every step of the progress widget and the notification lines. The duration of a compaction is therefore readable after the fact – in the console (the entry renders in the chat) and in web views that show session entries.
- `/protokoll export` gets the measured time of each compaction in its "Compactings" table.

## 0.9.1 – 2026-10-24

- When the model ignores the follow-up request for a missing block, the block is written from the turn's transcript right away instead of waiting for the next compaction.

## 0.9.0 – 2026-10-24

First packaged release (previously installed by hand into `~/.pi/agent/extensions/protokoll/`).

- Pi package: `pi install git:…` or `pi install ./pi-protokoll`; standalone tests against Pi from npm.
- English user interface, commands and documentation; the German command names still work.
- Index of older turns from the model's own `index` line; range lines from its `tags`.
- `/protokoll repair` brings older sessions up to date (missing protocols, index and tags).
- `/protokoll export` appends diagnostics (configuration, compactions, stored state, all turns, provider errors).
- State of work gets the room the lists leave; it is shortened evenly and never cut at the end.
- Review of rules may think (`consolidateReasoning`); later rules replace contradicting earlier ones.
- Progress widget stays within Pi's 10 widget lines.

## Before 0.9.0 (2026-10-07 – 2026-10-10)

Development in daily use with Qwen3.x on a local server: per-turn protocols, follow-up and
backfill requests that keep the prefix cache, runs as turns, tiered bounded summary, lookup
tools, pins, fork and tree support, persistent result widget.
