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
  "phase": "impl",
  "area": "services-server",
  "kind": "gotcha",
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
| `phase`      | `"planning" \| "impl" \| "both"`           | untagged ⇒ `both`. |
| `area`       | string                                     | opaque project-config string. |
| `kind`       | `"gotcha" \| "pattern" \| "decision" \| null` | optional human bucket; not used for retrieval. |
| `provenance` | `{ issue?: number, pr?: number }`          | traceability. |
| `date`       | `YYYY-MM-DD`                               | traceability + recency ranking. |
| `status`     | `"active" \| "deprecated"`                 | soft-delete; recall ignores non-active. |

## CLI (Layer 2)

Project-agnostic; every command takes `--dir <learnings-dir>`. Stable invocation
path: `node <this-project>/src/cli.mjs <command> …` (make it configurable in
consumers via e.g. a `LEARNINGS_CLI` setting).

### `recall`

```
node src/cli.mjs recall --dir <d>
  [--paths a/b.ts,c/d.ts]   # files in scope (e.g. plan target_files); omit = area-wide only
  [--phase planning|impl]   # omit = all phases
  [--area services-server]  # optional extra filter
  [--max-bytes 4000]        # token budget (default 4000)
  [--format text|json]      # text = grouped bullets (default); json = raw entries
```

Behavior: read all `*.ndjson`; keep `status=active`; phase filter
(`entry.phase==req || entry.phase=="both"` or untagged); path filter (any
`entry.paths` glob matches any `--paths`, OR `entry.paths==[]`); **rank**
path-specific > area-wide, then newer > older; **bound** to `--max-bytes`; emit.
**Exit 0 with empty output when nothing matches** — callers must tolerate empty.

### `learn`

```
node src/cli.mjs learn --dir <d> --area services-server --text "..."
  [--paths a/**,b.ts] [--phase impl] [--kind gotcha]
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
node src/cli.mjs migrate --md <area>.md --area services-server
  [--registry CLAUDE.md]    # infer default paths from the path-prefix table
  [--out <area>.ndjson]     # default: alongside the .md
```

Each bullet → entry: `phase` from `[planning]`/`[impl]` (else `both`); `paths`
from inline backtick paths, else the area's registry prefix, else `[]`; `kind`
from the subsection heading; `date` from a trailing `(YYYY-MM-DD)`. Keeps the
`.md`. Prints low-confidence rows (no inline path AND no tag) to stderr for a
human pass.

## Pure functions (`src/learnings-core.mjs`)

`normalizeForDedup`, `entryId`, `isDuplicate`, `parseEntries`, `globMatch`,
`matchEntry`, `rankEntries`, `boundByBytes`, `renderText`, `buildEntry`,
`mdBulletsToEntries`. All pure (no I/O / exit / clock except `buildEntry`'s
default date) and unit-tested. Front doors must compose these, never reimplement
parsing/dedup/scoping/ranking.
