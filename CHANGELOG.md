# Changelog

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
