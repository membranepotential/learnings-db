---
name: recall
description: Retrieve the codebase-engineering learnings that apply to the files you are about to work in, scoped by path. Use at the start of planning or implementation instead of reading whole learnings files. Trigger on "/recall", "recall learnings", or before touching an unfamiliar area.
allowed_tools: ["Bash"]
---

# Recall

Pull only the learnings that apply to the work in front of you — never read whole
learnings files. This skill is **thin**: it just runs the engine and uses what
comes back.

The engine is the `learnings` CLI on PATH. The learnings directory is the
project's `docs/learnings` unless configured otherwise.

## Steps

1. **Determine the files in scope.** Use the plan's `target_files`, the issue's
   target files, or the directory you are about to edit. These are the `--paths`.

2. **Run recall:**

   ```bash
   learnings recall \
     --dir docs/learnings \
     --paths <comma-separated files in scope>
   ```

   Add `--area <area>` to narrow further, `--max-bytes N` to tighten the budget.
   With no `--paths`, you get only the area-wide (cross-cutting) learnings.

3. **Use the returned bullets** as context for the plan/implementation. The
   output is already grouped by area and ranked (path-specific first, then
   newest). If the output is empty, there are simply no scoped learnings — proceed.

Do **not** open `docs/learnings/*.md` or `*.ndjson` directly; that re-introduces
the whole-file, token-heavy read this system replaces.
