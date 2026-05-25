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

   Add `--max-bytes N` to size each page. With no `--paths`, you get only the
   global (cross-cutting, `[]`) learnings.

3. **Use the returned bullets** as context for the plan/implementation. The
   output is a flat list **ordered most-relevant first** — earlier bullets matter
   most (most-specific path match, then newest); each bullet shows its path
   scope. Treat the top bullets as the highest-priority guidance. If the output
   is empty, there are simply no scoped learnings — proceed.

4. **Want more?** When the byte budget doesn't fit everything, recall prints a
   `note: page P/N …` to stderr. Re-run with `--page 2` (then `--page 3` …) to
   pull the next page of lower-ranked learnings — pages are disjoint, so you
   never re-read one you already have. Page only as far as you actually need;
   page 1 is the sharpest slice.

Do **not** open `.learnings.ndjson` (or any learnings file) directly; that
re-introduces the whole-file, token-heavy read this system replaces.
