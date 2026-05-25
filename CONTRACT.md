# CONTRACT — the shared learnings recall/learn API

This is the frozen interface that every front door (`/recall`, `/learn`, `/next`,
`/ce-compound`, a future MCP) depends on. Storage and CLI behavior here are
stable; change them only deliberately, with the tests in `tests/` updated in the
same commit. Derived from §3–§4 of `learnings-recall-learn-PLAN.md`.

## Storage (Layer 1)

- One NDJSON store: `<learnings-dir>/learnings.ndjson`. One JSON object per line.
- **Reads scan every `*.ndjson` in the dir and filter by per-entry globs** — there
  is no area/label map for retrieval. This structurally eliminates the
  orphaned-file bug. (Scanning all `*.ndjson`, not just `learnings.ndjson`, keeps
  legacy per-area files working during a migration; writes always land in
  `learnings.ndjson`.)

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
the predict-the-consumer coupling (§1) this system exists to remove. `area` was
a coarse, lossy duplicate of `paths` (`area: "services-server"` is just
`paths: ["services/server/**"]` written less precisely) and recall already
ignored it. Scoping is therefore **derived, not predicted**: by `paths` (from
data the agent already has, e.g. `target_files`) and recency. With `area` gone,
`paths` is the sole scoping axis — so keep them precise.

## CLI (Layer 2)

Project-agnostic; every command takes `--dir <learnings-dir>`. The stable
invocation is the `learnings` bin on `PATH` (a symlink to this project's
`src/cli.mjs`). Consumers call `learnings <command> …`.

### `recall`

```
learnings recall --dir <d>
  [--paths a/b.ts,c/d.ts]   # files in scope (e.g. plan target_files); omit = global ([]) only
  [--max-bytes 4000]        # token budget (default 4000)
  [--format text|json]      # text = flat bullets (default); json = raw entries
```

Behavior: read all `*.ndjson`; keep `status=active`; path filter (any
`entry.paths` glob matches any `--paths`, OR `entry.paths==[]`); **rank**
path-specific > global, then newer > older; **bound** to `--max-bytes`; emit.
**Exit 0 with empty output when nothing matches** — callers must tolerate empty.

### `learn`

```
learnings learn --dir <d> --text "..."
  [--paths a/**,b.ts]
  [--issue N] [--pr N] [--date YYYY-MM-DD]
  [--target-dir <abs>]      # OVERRIDES --dir for the write (worktree rule)
  [--allow-dup]             # default: skip if id already present
```

Behavior: build the entry, compute `id`; if `id` is present and not
`--allow-dup` → no-op, print `duplicate <id>`; else append one line to
`learnings.ndjson` (create dir/file if missing), print `added <id>`. **Always
writes to the explicit target path** (`--target-dir` wins over `--dir`) — this
is how stray writes are kept out of the wrong checkout.

### `migrate` (one-time, best-effort, non-destructive)

```
learnings migrate --md <file>.md
  [--out <file>.ndjson]     # default: alongside the .md, named after it
  [--blame]                 # fill candidate paths from each bullet's git history
```

Each bullet → entry: `paths` from inline backtick paths, else `[]` (global);
`date` from a trailing `(YYYY-MM-DD)`. Legacy `[planning]`/`[impl]` markers and
the trailing date are stripped from `text`. Keeps the `.md`. Prints
low-confidence rows (no inline path) to stderr. To build one store from several
`.md` files, migrate each then concatenate into `learnings.ndjson`.

**Scoping a migrated learning is two stages** (a bullet rarely names its own
paths):

1. **`--blame` (deterministic).** For each low-confidence bullet, `git blame` its
   source line → the commit that introduced it → that commit's changed files
   (excluding the `.md` and other docs) become candidate `paths`. The
   compound-with-code convention makes this a strong signal: a learning usually
   ships in the same commit as the code it's about.
2. **Agent/human tightening (judgment).** A commit touches more files than the
   learning is really about. A Claude Code pass (or human) narrows the candidate
   files to the precise globs and drops the irrelevant ones. This is build-order
   step 2's curation pass; the candidates are listed on stderr to drive it.

## Pure functions (`src/learnings-core.mjs`)

`normalizeForDedup`, `entryId`, `isDuplicate`, `parseEntries`, `globMatch`,
`matchEntry`, `rankEntries`, `boundByBytes`, `renderText`, `buildEntry`,
`mdBulletsToEntries`. All pure (no I/O / exit / clock except `buildEntry`'s
default date) and unit-tested. Front doors must compose these, never reimplement
parsing/dedup/scoping/ranking.
