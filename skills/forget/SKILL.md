---
name: forget
description: Remove a learning from the shared store when it is wrong, outdated, or was captured in error — soft-deleting it (status→deprecated) so recall ignores it, or purging the line outright. Trigger on "/forget", "that learning is wrong", "remove/retract the learning about …", or after recall surfaces a stale bullet.
allowed_tools: ["Bash"]
---

# Forget

The counterpart to `/learn`: retire a learning that should no longer surface. As
with the rest of the system, **the skill owns judgment; the engine owns the
write** — you never hand-edit a learnings file. The engine is the `learnings`
CLI on PATH.

## When to forget

Forget a learning when it is actively misleading, not merely less relevant:

- It is **wrong** — the claim was never true, or the bug it warns about doesn't
  exist that way.
- It is **outdated** — the code changed and the advice no longer applies.
- It was **captured in error** — a duplicate-in-spirit, too vague to act on, or
  not actually a reusable learning.

If a learning is still true but just didn't apply to *this* task, leave it —
recall's ranking already pushes off-point bullets down. Forgetting is for
learnings that would mislead the next reader.

## 1. Identify the target

Every learning has a stable 12-hex `id`, printed by `learn` (`added <id>`) and
recoverable from recall:

```bash
learnings recall --paths <files in scope> --format json   # find the id of the offending bullet
```

You can also let the engine re-derive the id from the **exact** learning text
(same hash `learn` used to mint it) — useful when you have the sentence but not
the id.

## 2. Choose soft-delete vs purge

- **Soft-delete (default)** — flips `status` to `deprecated`. The line stays in
  the store for provenance; recall ignores it. Reversible and auditable. This is
  almost always what you want.
- **`--purge`** — removes the line outright. Reserve it for entries that should
  leave no trace (sensitive content, or pure noise that isn't worth keeping as
  history).

## 3. Forget it

```bash
# by id (soft-delete)
learnings forget --id <id>

# by exact text
learnings forget --text "<the exact learning sentence>"

# remove the line entirely
learnings forget --id <id> --purge
```

- Reads/writes `.learnings.ndjson` in the cwd by default; pass `--file <path>`
  to target a different store.
- Prints `forgot <id>`, `purged <id>`, `already forgotten <id>` (a no-op), or
  `not found <id>` (a no-op) — all exit 0.
- **In a worktree/trunk setup**, pass `--target-file <worktree-abs>/.learnings.ndjson`
  so the edit lands on the right branch, not the main checkout.
