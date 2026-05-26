# CONTRACT — the shared learnings recall/learn API

This is the frozen interface that every front door (`/recall`, `/learn`, `/next`,
`/ce-compound`, a future MCP) depends on. Storage and CLI behavior here are
stable; change them only deliberately, with the tests in `tests/` updated in the
same commit.

## Storage (Layer 1)

- One NDJSON store **file**: `.learnings.ndjson` in the project root by default
  (override with `--file <path>`). One JSON object per line.
- **Reads load that one file and filter by per-entry globs** — there is no
  area/label map and no directory scan for retrieval. A single file plus
  per-entry globs structurally eliminates the orphaned-file bug.

### Entry schema

```json
{
  "id": "sha1(normalizeForDedup(text))[:12]",
  "text": "Register handlers in routes.ts before the test file (vitest discovery fails cold).",
  "paths": ["services/server/src/routes/**"],
  "provenance": { "issue": 477, "pr": 485 },
  "date": "2026-05-25",
  "status": "active"
}
```

| field        | type / values                              | notes |
|--------------|--------------------------------------------|-------|
| `id`         | string (12 hex)                            | stable hash of normalized `text` → dedup + idempotent upsert. |
| `text`       | string                                     | the learning. |
| `paths`      | glob[]                                     | **`[]` = global** (cross-cutting; matches every recall). |
| `provenance` | `{ issue?: number, pr?: number }`          | traceability. |
| `date`       | `YYYY-MM-DD`                               | traceability + recency ranking. |
| `status`     | `"active" \| "deprecated"`                 | soft-delete; recall ignores non-active. |

**Not in the contract:** there is deliberately no `phase`, `kind`, or `area`
field. `phase`/`kind` asked the *writer* to predict the *reader's* role/bucket —
the predict-the-consumer coupling this system exists to remove. `area` was
a coarse, lossy duplicate of `paths` (`area: "services-server"` is just
`paths: ["services/server/**"]` written less precisely) and recall already
ignored it. Scoping is therefore **derived, not predicted**: by `paths` (from
data the agent already has, e.g. `target_files`) and recency. With `area` gone,
`paths` is the sole scoping axis — so keep them precise.

## CLI (Layer 2)

Project-agnostic; `recall`/`learn` take `--file <learnings.ndjson>` (default
`.learnings.ndjson` in the cwd). The stable invocation is the `learnings` bin on
`PATH` (a symlink to this project's `src/cli.mjs`). Consumers call
`learnings <command> …`.

### `recall`

```
learnings recall [--file <learnings.ndjson>]   # default .learnings.ndjson
  [--paths a/b.ts,c/d.ts]   # files in scope (e.g. plan target_files); omit = global ([]) only
  [--max-bytes N]           # opt-in byte budget per page; default unbounded (all matched)
  [--page 1]                # 1-based page (only meaningful with --max-bytes)
  [--format text|json]      # text = flat bullets (default); json = raw entries
```

Behavior: read the store file (missing file ⇒ empty); keep `status=active`; path
filter (any `entry.paths` glob matches any `--paths`, OR `entry.paths==[]`);
**rank** most-relevant first; emit **all** matched entries (unbounded by
default). **Exit 0 with empty output when nothing matches** — callers must
tolerate empty. The default favors **recall over precision**: issue/planning
callers want every learning that could apply, ranked, and tolerate some noise.

**Ranking — earlier = more relevant.** The list is ordered so the first bullets
are the most relevant, which is exactly what a page keeps:

1. path-specific matches before global (`[]`) entries;
2. within the path-specific tier, the **more specific matching glob first** —
   an exact-file learning outranks a deep glob, which outranks a broad
   `services/**` catch-all that merely also covers the file;
3. then newer date before older.

**Output annotation — the matching rule.** Each rendered bullet ends with *why
it surfaced*, so the consumer can judge relevance: `(global)` for a cross-cutting
`[]` entry, otherwise the entry glob(s) that actually matched `--paths` (the
matching rule, not the entry's full scope — non-matching globs are hidden).

**Pagination (opt-in via `--max-bytes`).** With no `--max-bytes` recall is
unbounded — one page with every matched entry. Passing a positive `--max-bytes`
bounds each page to that many bytes of whole, ranked entries — a learning is
never split or truncated across a page boundary (an entry larger than the budget
gets its own page). Pages are **disjoint and exhaustive**, so `--page 2`,
`--page 3` … walk the lower-ranked tail without re-emitting anything the caller
already saw. When more than one page exists, a `note: page P/N, showing … most
relevant first. Re-run with --page P+1 …` line is written to **stderr** (stdout
stays pure bullets/JSON) so the cutoff is never silent.

### `learn`

```
learnings learn --text "..." [--file <learnings.ndjson>]   # default .learnings.ndjson
  [--paths a/**,b.ts]
  [--issue N] [--pr N] [--date YYYY-MM-DD]
  [--target-file <abs>]     # OVERRIDES --file for the write (worktree rule)
  [--allow-dup]             # default: skip if id already present
```

Behavior: build the entry, compute `id`; if `id` is present and not
`--allow-dup` → no-op, print `duplicate <id>`; else append one line to the store
file (create parent dir/file if missing), print `added <id>`. **Always writes to
the explicit target path** (`--target-file` wins over `--file`) — this is how
stray writes are kept out of the wrong checkout.

## Pure functions (`src/learnings-core.mjs`)

`normalizeForDedup`, `entryId`, `isDuplicate`, `parseEntries`, `globMatch`,
`matchEntry`, `globSpecificity`, `rankEntries`, `paginateByBytes`,
`boundByBytes`, `renderText`, `buildEntry`. All pure (no I/O / exit / clock
except `buildEntry`'s default date) and unit-tested. Front doors must compose
these, never reimplement parsing/dedup/scoping/ranking.
