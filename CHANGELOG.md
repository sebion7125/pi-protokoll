# Changelog

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
