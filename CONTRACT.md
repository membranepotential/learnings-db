# CONTRACT — the shared learnings recall/learn API

This is the frozen interface that every front door (`/recall`, `/learn`, `/next`,
`/ce-compound`, a future MCP) depends on. Storage and CLI behavior here are
stable; change them only deliberately, with the tests in `tests/` updated in the
same commit. Derived from §3–§4 of `learnings-recall-learn-PLAN.md`.

## Storage (Layer 1)

- One NDJSON file per area: `<learnings-dir>/<area>.ndjson` (1:1 with the legacy
  `<area>.md`). One JSON object per line.
- **Reads scan every `*.ndjson` and filter by per-entry globs** — there is no
  area/label map for retrieval. This structurally eliminates the orphaned-file
  bug. A `CLAUDE.md` path-prefix registry (and the `area` field) guide **writes**
  and human navigation only.

### Entry schema

```json
{
  "id": "sha1(normalizeForDedup(text))[:12]",
  "text": "Register handlers in routes.ts before the test file (vitest discovery fails cold).",
  "paths": ["services/server/src/routes/**"],
  "area": "services-server",
  "provenance": { "issue": 477, "pr": 485 },
  "date": "2026-05-25",
  "status": "active"
}
```

| field        | type / values                              | notes |
|--------------|--------------------------------------------|-------|
| `id`         | string (12 hex)                            | stable hash of normalized `text` → dedup + idempotent upsert. |
| `text`       | string                                     | the learning. |
| `paths`      | glob[]                                     | **`[]` = applies to the whole `area`** (cross-cutting). |
| `area`       | string                                     | opaque project-config string. |
| `provenance` | `{ issue?: number, pr?: number }`          | traceability. |
| `date`       | `YYYY-MM-DD`                               | traceability + recency ranking. |
| `status`     | `"active" \| "deprecated"`                 | soft-delete; recall ignores non-active. |

**Not in the contract:** there is deliberately no `phase` or `kind` field. Both
asked the *writer* to predict the *reader's* role/bucket — the same
predict-the-consumer coupling (§1) this system exists to remove. Scoping is
derived, not predicted: by `paths` (from data the agent already has, e.g.
`target_files`) and recency. `kind` was also never used for retrieval. A
consumer that still wants a planning/impl split can layer it as its own
convention; the shared store stays minimal.

## CLI (Layer 2)

Project-agnostic; every command takes `--dir <learnings-dir>`. The stable
invocation is the `learnings` bin on `PATH` (a symlink to this project's
`src/cli.mjs`). Consumers call `learnings <command> …`.

### `recall`

```
learnings recall --dir <d>
  [--paths a/b.ts,c/d.ts]   # files in scope (e.g. plan target_files); omit = area-wide only
  [--area services-server]  # optional extra filter
  [--max-bytes 4000]        # token budget (default 4000)
  [--format text|json]      # text = grouped bullets (default); json = raw entries
```

Behavior: read all `*.ndjson`; keep `status=active`; path filter (any
`entry.paths` glob matches any `--paths`, OR `entry.paths==[]`); optional `area`
filter; **rank** path-specific > area-wide, then newer > older; **bound** to
`--max-bytes`; emit. **Exit 0 with empty output when nothing matches** — callers
must tolerate empty.

### `learn`

```
learnings learn --dir <d> --area services-server --text "..."
  [--paths a/**,b.ts]
  [--issue N] [--pr N] [--date YYYY-MM-DD]
  [--target-dir <abs>]      # OVERRIDES --dir for the write (worktree rule)
  [--allow-dup]             # default: skip if id already present
```

Behavior: build the entry, compute `id`; if `id` is present and not
`--allow-dup` → no-op, print `duplicate <id>`; else append one line to
`<area>.ndjson` (create dir/file if missing), print `added <id>`. **Always
writes to the explicit target path** (`--target-dir` wins over `--dir`) — this
is how stray writes are kept out of the wrong checkout.

### `migrate` (one-time, best-effort, non-destructive)

```
learnings migrate --md <area>.md --area services-server
  [--registry CLAUDE.md]    # infer default paths from the path-prefix table
  [--out <area>.ndjson]     # default: alongside the .md
```

Each bullet → entry: `paths` from inline backtick paths, else the area's
registry prefix, else `[]`; `date` from a trailing `(YYYY-MM-DD)`. Legacy
`[planning]`/`[impl]` markers and the trailing date are stripped from `text`.
Keeps the `.md`. Prints low-confidence rows (no inline path) to stderr for a
human pass.

## Pure functions (`src/learnings-core.mjs`)

`normalizeForDedup`, `entryId`, `isDuplicate`, `parseEntries`, `globMatch`,
`matchEntry`, `rankEntries`, `boundByBytes`, `renderText`, `buildEntry`,
`mdBulletsToEntries`. All pure (no I/O / exit / clock except `buildEntry`'s
default date) and unit-tested. Front doors must compose these, never reimplement
parsing/dedup/scoping/ranking.
