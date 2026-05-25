---
name: learn
description: Extract genuine, reusable, non-obvious learnings from recent work and persist each one to the right per-area learnings store, scoped by path. Use before committing — learnings ship with the code that produced them. Trigger on "/learn", "capture learnings", or after finishing a non-trivial change.
allowed_tools: ["Bash", "Read", "Grep"]
---

# Learn

Feed what was learned back into the system so future work is easier. **The skill
owns judgment; the engine owns persistence.** For each learning you formulate,
you call the engine once — you never hand-edit a learnings file.

The engine is the `learnings` CLI on PATH.

## 1. Identify genuine learnings

Look at the recent work (diff, plan, review findings already in context). For each
candidate, ask:

- Was there a bug that represents a **class** of bugs? (e.g. "always check null
  before reading nested API fields")
- A pattern that worked well and should be reused?
- A decision that was hard to make whose reasoning should be preserved?
- A mistake that cost time and is preventable next time?
- Something the plan missed that future plans should catch?

Keep only **non-obvious, reusable** learnings. Skip anything already obvious from
the code, the docs, or a quick read of the area. One crisp sentence each.

## 2. Scope each learning

- **area** — the smallest area it belongs to (matches the project's per-area
  learnings + the `CLAUDE.md` path-prefix registry). Pick one.
- **paths** — the glob(s) it applies to (`services/server/src/routes/**`). Use the
  files the work touched. **Omit / leave empty only for genuinely cross-cutting
  learnings** that apply to the whole area.

## 3. Persist each learning

One call per learning. Dedup is automatic (idempotent on normalized text):

```bash
learnings learn \
  --dir docs/learnings \
  --area <area> \
  --text "<one-sentence learning>" \
  --paths <glob[,glob]> \
  [--issue N] [--pr N]
```

- It prints `added <id>` or `duplicate <id>` (already captured — fine, move on).
- **In a worktree/trunk setup**, pass `--target-dir <worktree-abs>/docs/learnings`
  so the write lands on the right branch, not the main checkout.

Don't batch multiple learnings into one `--text`; one entry per learning so each
is independently recallable and dedupable.
