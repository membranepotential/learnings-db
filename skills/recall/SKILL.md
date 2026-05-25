---
name: recall
description: Retrieve the codebase-engineering learnings that apply to the files you are about to work in, scoped by path. Use at the start of planning or implementation instead of reading whole learnings files. Trigger on "/recall", "recall learnings", or before touching an unfamiliar area.
allowed_tools: ["Bash"]
---

# Recall

Pull only the learnings that apply to the work in front of you — never read whole
learnings files. This skill is **thin**: it just runs the engine and uses what
comes back.

The engine is the `learnings` CLI on PATH. The store is the project's
`.learnings.ndjson` file unless configured otherwise (pass `--file <path>`).

## Steps

1. **Determine the files in scope.** Use the plan's `target_files`, the issue's
   target files, or the directory you are about to edit. These are the `--paths`.

2. **Run recall:**

   ```bash
   learnings recall \
     --paths <comma-separated files in scope>
   ```

   (reads `.learnings.ndjson` in the cwd; add `--file <path>` for a different store.)

   By default recall is **unbounded** — it returns *every* learning that could
   apply, ranked most-relevant first. That's intentional for planning: you want
   high recall and can judge out the few that don't fit. With no `--paths`, you
   get only the global (cross-cutting, `[]`) learnings.

3. **Use the returned bullets** as context for the plan/implementation. The
   output is a flat list **ordered most-relevant first** (most-specific path
   match, then newest). Each bullet ends with its **matching rule** — the glob
   that matched (e.g. `(services/app/src/lib/components/review/**)`) or
   `(global)` for cross-cutting ones — so you can judge how directly it applies:
   an exact/narrow glob is squarely on-point; a broad glob or `(global)` is more
   ambient. If the output is empty, there are no scoped learnings — proceed.

4. **Too much?** Only if you need to bound the volume, pass `--max-bytes N` to
   page the ranked list (`--page 2`, `--page 3` … walk disjoint pages, no
   repeats). You usually won't need this for a single issue.

Do **not** open `.learnings.ndjson` (or any learnings file) directly; that
re-introduces the whole-file, token-heavy read this system replaces.
