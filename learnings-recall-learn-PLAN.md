# Plan: shared learnings `recall` + `learn` system

Status: **design / spec** (no code yet). To be built in its own project folder, then
wired into `~/.claude/skills` and consumed by `/next`, `/ce-compound`, and future
compounding skills.

Decisions locked (2026-05-25):

- Scope: **Layers 1–2 + thin skills** (engine + contract + tests, `/recall` + `/learn`
  skills, rewire `/next` and `/ce-compound`). **MCP deferred.**
- Storage shape: **NDJSON records** (one JSON object per learning).

---

## 1. Why

`/ce-compound` and `/next` already share the learnings *storage* (`docs/learnings/<area>.md`
+ `**[planning]**`/`**[impl]**` tags) but use **two divergent, hand-maintained attribution
maps** over the same files:

- **ce-compound** → path-prefix → file, via a registry table in root `CLAUDE.md`.
- **next** → issue-label → file, via `.next/config.json`'s `learnings` map (`pickLearningsFile`,
  `next.mjs:632`).

The maps drifted: in the scribetech project there are **11 learnings files (~488 KB; one is
90 KB)**, but next's label map references only **5** — so 6 files are **orphaned from the
reader**. And both readers load the **whole file** (no bullet-level scoping). Result:
exploration/learnings is a large, lossy, token-heavy step.

**Fix:** one shared read/write contract over a queryable store. Recall returns only the
matching entries (token-bounded); attribution is by **path-glob + phase**, computed from
data the agent already has (`target_files`); writes go through one deduping, correct-path
implementation (which also kills the "relative-path write stranded in the main checkout"
drift bug `next` fought for weeks).

Non-goals / keep separate: Claude Code auto-memory (eager-loaded user prefs) and Serena
memories (name-keyed). This system is **path/phase-scoped codebase engineering knowledge**.

---

## 2. Architecture (layered; the *contract* is the shared thing, not the delivery)

```
Layer 1  Storage   docs/learnings/<area>.ndjson   (textual, git-native, per-area)
Layer 2  Engine    learnings CLI + pure lib       <-- THE SHARED CONTRACT (+ tests)
Layer 3  Front     /recall skill   (thin -> recall)
         doors     /learn  skill   (judgment -> learn)
                   /next           (calls scripts DIRECTLY; no LLM indirection)
                   /ce-compound     (thin wrapper -> learn)
   (deferred)      MCP adapter      (stateless over the same engine; 2 tools)
```

Rule: **all front doors call the same engine.** None reimplements parsing/dedup/scoping.
The MCP, if/when added, is just another caller — files stay the source of truth, the MCP
is stateless over them (never an in-memory DB that drifts across worktrees).

---

## 3. Storage spec (Layer 1)

- One NDJSON file per area: `docs/learnings/<area>.ndjson` (1:1 with today's `<area>.md`).
- One JSON object per line. **Reads scan all `*.ndjson` and filter by per-entry globs** —
  no area/label map needed for retrieval. This structurally eliminates the orphaned-file
  bug. The `CLAUDE.md` path-prefix registry (and `area`) guide **writes** and human
  navigation only.

### Entry schema

```json
{
  "id": "sha1(normalizedText)[:12]",
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

- `id`: stable hash of normalized `text` → dedup + idempotent upsert. (Reuse next's
  `normalizeForDedup` from `next/scripts/lib/drift.mjs` for consistency.)
- `paths`: glob list. **`[]` = applies to the whole `area`** (cross-cutting learning).
- `phase`: `"planning" | "impl" | "both"` (replaces untagged = both).
- `kind`: optional bucket (`gotcha | pattern | decision | null`) — preserves today's
  subsections for humans; not required for retrieval.
- `provenance`, `date`: traceability. `status`: `active | deprecated` (soft-delete; recall
  ignores non-active).

---

## 4. The contract (Layer 2) — CLI

Project-agnostic: every command takes `--dir <learnings-dir>`. Stable invocation path
(e.g. `node <project>/src/cli.mjs ...`) referenced by all consumers; make it configurable.

### `recall`

```
learnings recall --dir docs/learnings
  [--paths a/b.ts,c/d.ts]   # files in scope (e.g. plan target_files); omit = area-wide only
  [--phase planning|impl]   # omit = all phases
  [--area services-server]  # optional extra filter
  [--max-bytes 4000]        # token budget; default sensible
  [--format text|json]      # text = grouped bullets for prompt injection (default)
```

Behavior: read all `*.ndjson`; keep `status=active`; phase filter (`entry.phase==req ||
entry.phase=="both"`); path filter (any `entry.paths` glob matches any `--paths` OR
`entry.paths==[]` and its area is in scope); **rank** path-specific > area-wide, then newer
> older; **bound** to `--max-bytes`; emit. Exit 0 with empty output when nothing matches
(callers must tolerate empty).

### `learn`

```
learnings learn --dir docs/learnings --area services-server
  --text "..."  [--paths a/**,b.ts] [--phase impl] [--kind gotcha]
  [--issue N] [--pr N] [--date YYYY-MM-DD]
  [--target-dir <abs>]      # worktree-absolute learnings dir; OVERRIDES --dir for the write
  [--allow-dup]             # default: skip if id already present
```

Behavior: build entry, compute `id`; if `id` present and not `--allow-dup` → no-op, print
`duplicate`; else append a line to `<area>.ndjson` (create if missing), print `added <id>`.
**Always write to the explicit target path** (the `--target-dir` worktree rule) — this is
how we avoid the stranded-in-main-checkout drift class.

### `migrate` (one-time)

```
learnings migrate --md docs/learnings/services-server.md --area services-server
  --registry CLAUDE.md   # to infer default paths from the path-prefix table
  [--out docs/learnings/services-server.ndjson]
```

Best-effort: each bullet → entry; `phase` from `[planning]`/`[impl]` tag (else `both`);
`paths` from inline paths in the bullet, else the area's registry prefix, else `[]`;
`kind` from the subsection heading; `date` from a trailing `(YYYY-...)` if present.
**Non-destructive** (keeps `.md`); flag low-confidence rows for a human pass.

### Pure functions (testable, in `src/learnings-core.mjs`)

`parseEntries(text)`, `globMatch(glob, path)`, `matchEntry(entry, {paths, phase, area})`,
`rankEntries(entries, {paths})`, `boundByBytes(entries, max)`, `normalizeForDedup(s)`
(port from drift.mjs), `entryId(text)`, `isDuplicate(text, entries)`,
`renderText(entries)` (grouped bullets), `mdBulletsToEntries(md, opts)` (migration).

---

## 5. Front doors (Layer 3)

- **`/recall` skill** — thin. "Determine the files in scope (plan `target_files` / the dir
  you're about to work in), run `learnings recall --paths … --phase …`, use the returned
  bullets. Don't read whole learnings files." Mostly delegates to the script.
- **`/learn` skill** — judgment + mechanics. Prompt carries the extraction rules currently
  in `ce-compound` (what's a genuine non-obvious learning; pick the smallest area;
  `[planning]` vs `[impl]`; dedup-mindset). For each learning it formulates, it calls
  `learnings learn …` once. The skill owns *judgment*; the script owns *persistence*.

---

## 6. Integration with existing skills

- **`/next` (calls scripts directly — no skill, no LLM indirection):**
  - *Recall:* in the picker (`next.mjs`), replace `pickLearningsFile` with a call to
    `learnings recall --paths <issue/plan target files> --phase planning` and pass the
    **bullets** to the plan prompt (alongside how it already injects issue body/comments).
    Implementer phase: `--phase impl`. Drop the `.next/config.json` `learnings` label-map.
  - *Learn:* the compound phase calls `learnings learn --target-dir <worktree-abs>/docs/learnings …`
    per extracted entry. The existing drift guard still backstops stray writes.
  - **Safe rollout:** stage recall *additively* first (inject NDJSON bullets *in addition
    to* the current whole-file read, or behind a `cfg.learnings.mode` flag) so a regression
    can't blind the live autopilot; remove the old path once metrics confirm parity.
- **`/ce-compound`:** becomes a thin wrapper that formulates entries (its existing judgment)
  and calls `learnings learn …`; keep it maintaining the `CLAUDE.md` registry row.
- **`/ce-plan`, `/ce-review`, `/ce-run`:** add a `/recall` step at the start (they already
  say "read the corresponding learnings file" in prose — swap for scoped recall).

Single source of truth for attribution = **path-glob (per entry) + the `CLAUDE.md`
path-prefix registry for write-routing**. next's label map is retired.

---

## 7. Tests

Node built-in runner, no deps, mirroring `next/scripts/test.sh` (`node --test
tests/**/*.test.mjs`, Node-20-safe glob). Cover the pure fns: glob matching edge cases,
phase/path filtering, ranking order, byte-bounding, dedup/id stability, migration parsing
(tagged/untagged/inline-path/dated bullets). Aim for the same pure-core + thin-CLI split
next uses (`preflight-predicates.mjs` + tests is the model).

---

## 8. Deferred: MCP adapter

Only if ubiquitous interactive recall/learn is wanted (hand-coding, ad-hoc sessions).
Constraints: stateless over the text files (files = truth; no divergence across ephemeral
worktrees); exactly **two** tools (`recall`, `learn`), deferred-loaded; **not** used by
headless `/next` (scripts there are deterministic and cheaper). It calls the same Layer-2
engine — never reimplements logic.

---

## 9. Risks & mitigations

- **Three front doors, one contract** → keep skill/MCP adapters ≤ ~20 lines; logic lives
  only in the engine.
- **Migration noise / mis-attribution** → non-destructive, low-confidence flagging, human
  pass; recall falls back gracefully (area-wide entries) until paths are curated.
- **NDJSON PR-diff noise & append merge-conflicts** → per-area files spread contention;
  append-only at EOF; if batch-mode concurrency bites, serialize via the existing
  per-iteration commit flow.
- **Taxonomy convergence** → treat `area`/`phase` as opaque strings from project config;
  the `CLAUDE.md` registry is the one write-routing map.
- **Tool-surface cost** (MCP) → learned from the Serena pilot; two tools, deferred.

---

## 10. Suggested project layout (the "different folder")

```
learnings/
  CONTRACT.md            # §3–§4 frozen as the API others depend on
  package.json           # { "type": "module" }, no runtime deps
  src/learnings-core.mjs # pure fns
  src/cli.mjs            # recall | learn | migrate
  scripts/test.sh        # node --test tests/**/*.test.mjs
  tests/*.test.mjs
  skills/recall/SKILL.md # thin; symlinked into ~/.claude/skills/recall
  skills/learn/SKILL.md  # judgment; symlinked into ~/.claude/skills/learn
```

Wire-up: symlink `skills/recall` + `skills/learn` into `~/.claude/skills`; reference
`src/cli.mjs` by a stable, configurable path from `/next` and `/ce-compound`.

## 11. Build order

1. Engine (`learnings-core.mjs` + `cli.mjs` recall/learn) + tests — verifiable in isolation.
2. `migrate` + run on scribetech's 11 files (non-destructive) + human curation pass.
3. `/recall` + `/learn` skills.
4. Rewire `/ce-compound` (low risk).
5. Rewire `/next` (recall additive/flagged first, then retire label-map) — **riskiest, last**.
