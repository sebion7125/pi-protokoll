# Changelog

## Unreleased

- **`/protokoll recall` scores with a judge, and `--tools` lets the model look things up.** The first run on a long real session showed the word-overlap score was unusable: answers that got the core right scored 0.11–0.24, three answers tried to call `protocol_search` (and counted as misses), and twice the answer with the state of work confidently described the wrong turn. Now every answer goes to a judge request that rates it correct, partial, unknown or wrong against the protocol – wrong (asserting something that does not match) is kept apart from unknown because it is the worse failure. An answer that writes a tool call although no tools were declared counts as `lookup` without a judge. `--tools` gives the model `protocol_search`, `protocol_read` and `protocol_turn` (the same code as the registered tools) in a small loop of up to six rounds, as in a real session, and the report counts the lookups. `--judge` is gone (judging is always on); word overlap is still computed and stored as information only. The `protokoll-recall` entry is now version 2; older version-1 entries are still shown.
- `--file` paths for `export`, `stats` and `recall` expand `~` to the home folder (the shell does not do it inside a Pi command; `~/recall.md` used to end up as a folder named `~` in the working directory). `recall` checks the target folder before it asks the model, and if writing still fails it saves the report in the working directory instead of losing the answers.

## 0.9.12 – 2026-11-17

- **`/protokoll recall [n]` – does the summary still know the old facts?** It answers the question on the user's own session instead of in the abstract. From the turns that left the context (before the `keepRecentTurns` boundary), that the summary no longer quotes in its detail tier (there the protocol stands word for word, so the answer would be in the context with and without the state of work), whose protocol states a result or a decision and whose user message has at least 20 characters, it picks `n` (default 5, at most 20) in equal steps, so the same arguments give the same questions again; `--seed N` rotates the list. The question quotes only the user's own words from that turn – never the protocol, never the turn number – and is asked twice: against the summary as the settings would build it (A) and against the same one with `stateOfWork: false` (B), built by `assemble()` with a settings override, so the stored configuration is never touched. The turns that are still verbatim go along; the requests carry no tools, so only what the summary itself holds can answer (300 tokens of answer budget, and a run stops with a message if A or B does not fit the window). Scoring needs no second model: word overlap with the protocol's result and decision, a hit from similarity 0.25, with "that is not in the context"-style answers counted as zero; `--judge` adds the model's own 0/1/2 next to it. `--fold` folds a fresh state of work first, otherwise the stored one is used and the report says which. The run ends with one `protokoll-recall` entry (turns, totals, model calls, threshold) so later runs are comparable; it is a custom entry and never part of a context. Checked live in a throwaway session (3 turns, one candidate outside the verbatim tier): A 1 hit, mean 0.263 against B 1 hit, mean 0.313, 2 model calls, and the session file gained exactly that one entry.

- **`/protokoll stats [--file <path>]` – one row per compaction, each number with its meaning.** Two different "after compaction" numbers were being quoted for one and the same session (about 35k and about 67k tokens) because nothing said which part of the context they measure: the 35k is only the summary the compaction wrote, the 67k is everything the next request carries. The numbers the `session_compact` handler already computed for its notification are now stored as a `protokoll-compact-after` entry (total, system prompt, summary, kept turns, window, and which extension wrote the summary), and `stats` joins the compaction entries with that entry and with the pass entry before them: before, after total, system, summary, kept, duration, the condensed / detail / kept turn counts and the turns that left without a protocol. Session totals add turns and protocol rate, compactions by protokoll / Pi / no room / failed, medians and maxima of before, after total, summary and duration, and the prompt cache read from the provider's own usage data (`usage.cacheRead` on each answer – a session without those fields says so instead of printing zeros). A legend states every column, and anything a version did not store shows as `–`. `--file <path>` writes the whole table as Markdown; the notification shows the newest eight cuts.

## 0.9.11 – 2026-11-15

- **Answers from a question tool count as user input** (#3, thanks @Tutanchamon). A package that asks the user questions in a web UI (pi-web's `ask_user`) stores the answers as a `custom_message`; they were neither a turn start nor part of any user text, so the next compaction dropped them and every later summary kept saying the answers were pending. They now start the turn that works with them, are kept verbatim with `keepUserMessages`, and `protocol_turn` returns them.
- A state of work written in the old version-2 numbering is renumbered with the counting rule of that time, so the answers do not shift its turn references.
- **Sessions that already contain such answers and were compacted before this version:** the answers now start their own turn, so the turn numbers in the stored state of work are off by one from that point. Run `/protokoll rebuild` once; the next compaction rebuilds the state from the protocols with the new numbering.

## 0.9.10 – 2026-11-08

- Both READMEs state what a compaction does to the context and the prefix cache, measured on the session in the chart: about 213,000 → a median of 67,000 tokens in the next request (about 38,000 of them the summary), 99.8 % of the prompt tokens from the cache in the median request, about 62,000 tokens read again once right after a cut.
- More keywords for the npm search: `context-compaction`, `prompt-cache`, `kv-cache`, `incremental-summary`, `long-sessions`, `llama.cpp`, `ollama`.

## 0.9.9 – 2026-11-07

- **Preview image corrected.** The hatched "tool schemas + chat template (derived)" segment of the old chart was mostly counting error: `ceil(chars / 3.5)` against a tokenizer that needs 2.5–3.7 characters per token in the summary, depending on how much code and how many paths it holds. Measured on the same session (now 12 days, 224 turns by `collectTurns`, 24 compactions, 2,923 calls): the first request – system prompt, tool schemas, chat template – costs 4,365 tokens, so schemas and template are at most about 1k and constant. The new chart rebuilds every request with pi's projection *and* its replay rules (thinking from another model and aborted replies are not sent), prices the transcript at rates fitted on 2,876 consecutive requests (tool output 3.0, tool calls 3.1, own turns 3.2, reasoning 3.5, answers 3.3 characters per token, 9 tokens framing per message, 231 tokens RMS error), and gives pi-protokoll's summary the remainder of the reported total, split across its tiers by character share. The old turn count (236) was wrong as well. The session also ran for 30 minutes on a cloud model (Kimi K3.1), brought in once to draft a plan; the chart now marks that window instead of saying "no cloud".

## 0.9.8 – 2026-11-06

- **The lookup tools (`protocol_turn`, `protocol_read`, `protocol_search`) are declared only once the session holds a compaction.** Before that every turn is still in the context and there is nothing to look up. A reported session (Qwen 3.8-27B) with a single message "hi" ran 35 rounds in which the model called `protocol_turn(1)`, `(2)`, `(3)` … and each result said the turn did not exist; the extension had written nothing, the loop was the tool calls alone. A compaction rewrites the context anyway, so declaring the tools then costs no extra cache. The "turn does not exist" result now says how many turns there are and tells the model not to try further numbers.
- **`stateOfWork: false`** switches the state of work off (default `true`). Without it there is no fold request at compaction – the slowest step, and the only text the model rewrites every time – and the `State of work` section is left out of the summary. The index takes the status budget the text would have had, so it keeps single lines for more turns before older ones are grouped. Earlier summaries written by Pi itself are not merged in this mode; switching back on folds the turns that left the detail tier in the meantime.
- **Afterwards-only mode** (`"inline": false`, default `true`). Nothing about the protocol goes into the system prompt – no section, no length note – so the model never sees the format while it works. After every final answer the extension sends one extra request: the unchanged chat context plus one instruction that carries the format itself, so a prefix cache reads only the new tokens. The follow-up is always on in this mode; the requests for interrupted turns and for compaction in the middle of a turn carry the format the same way. `/protokoll on|off` needs no switch notes in this mode. With `inline: true` all texts and requests are byte-identical to before, so existing sessions keep their prefix cache. For models that ignore or are confused by the inline instruction.
- The model is asked for 90 % of the state-of-work budget instead of 100 %; the hard limit stays what the settings say. It rarely hits a length target exactly, and a state that ends up slightly over was cut in the middle.
- Preview image for the Pi package catalogue: `pi.image` in `package.json` points to `docs/preview.png`, a chart built only from measured data of one real session (10 days, 236 turns, 23 protokoll compactions, 2,786 model calls). Top: the context of every model call (`input + cacheRead + cacheWrite`) with the cuts marked. Bottom: one bar per cut, stacked by what the following request actually carried – system prompt and the derived remainder (tool schemas, chat template, counting error), pi-protokoll’s own text (open items/files/review/header, active rules, state of work, index of older turns, detail tier), and above the white line everything kept word for word (reasoning, answers, tool output, tool call arguments, own turns). Segments come from pi’s own context projection (`buildSessionContext`) and the stored summary tiers, token estimate `ceil(chars / 3.5)`; the hatched part is a difference, not a measurement. Both READMEs show the image through the raw URL, so the tarball stays as it is.

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
