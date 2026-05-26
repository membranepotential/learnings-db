> # 🤖⚠️🚨 WARNING: AI-SLOP 🚨⚠️🤖
> 🧠💾 This repository was designed, written, and documented largely by an AI agent. 💾🧠
> 🪄✨ Read it with the appropriate amount of suspicion. ✨🪄
> 🦾🤔 No human guarantees the prose below is free of confident nonsense. 🤔🦾

---

# learnings — a shared `recall` + `learn` for codebase engineering 📚

A tiny, dependency-free CLI and storage contract for **capturing** the non-obvious
lessons you learn while working in a codebase, and **recalling** only the ones that
apply to the files you're about to touch.

Think of it as institutional memory for an engineering workflow: every painful
discovery ("vitest won't find this handler unless it's registered before the test
file") gets written down once, scoped to the paths it's about, and surfaced again
— ranked by relevance — the next time someone (human or agent) opens those files.

This is the memory layer for [**compound engineering**](https://every.to/guides/compound-engineering)
— the practice of building development systems where each unit of work makes the
next one easier: every bug becomes a permanent lesson, every review updates the
defaults. A learnings store is what lets the system *compound* instead of
relearning the same thing every session. 🔁

## Why this exists 🤨

This project replaces the **hand-maintained, whole-file attribution maps** that
agent workflows used to keep over the codebase. Keeping a whole-file label map in
sync by hand is exactly the kind of chore that rots: files move, maps don't, and
you end up with **orphaned entries** pointing at code that no longer exists.

The fix is structural, not disciplinary:

- **One store, not many.** A single append-only `.learnings.ndjson` (one JSON
  object per line) instead of a directory of per-area files plus a registry.
- **Scoping is derived, not predicted.** Each learning carries the **path globs**
  it applies to. Recall loads the one file and filters by glob — no directory
  scan, no area/label map to drift out of sync. A single file + per-entry globs
  *structurally* eliminates the orphaned-file bug.
- **No "predict the consumer" fields.** Nothing asks the *writer* to guess the
  *reader's* role or bucket. The only scoping axis is `paths` (data the agent
  already has, e.g. a plan's target files) plus recency. So keep your globs
  precise. 🎯
- **Recall returns only what matches.** Instead of dumping a whole learnings file
  into context, recall returns the matching entries, ranked most-relevant-first,
  with an optional byte budget per page.

## Install 🔧

Zero runtime dependencies. Node ≥ 20. The stable entry point is the `learnings`
bin on your `PATH` (a symlink to `src/cli.mjs`).

```bash
git clone https://github.com/membranepotential/learnings-db.git
cd learnings-db

# put `learnings` on PATH
ln -sfn "$PWD/src/cli.mjs" ~/.local/bin/learnings

# (optional) wire up the Claude Code /recall and /learn skills
ln -sfn "$PWD/skills/recall" ~/.claude/skills/recall
ln -sfn "$PWD/skills/learn"  ~/.claude/skills/learn
```

## Usage 🚀

### Capture a learning — `learn`

Dedupes on the normalized text (a stable 12-hex `id`), then appends one line.

```bash
learnings learn \
  --text "Register handlers in routes.ts before the test file (vitest discovery fails cold)." \
  --paths "services/server/src/routes/**" \
  --issue 477 --pr 485
```

Omit `--paths` (or pass an empty list) to make a learning **global** — it then
matches every recall as a cross-cutting note.

### Recall what applies — `recall`

```bash
# what do we know about the files I'm about to edit?
learnings recall --paths services/server/src/routes/foo.ts
```

Recall reads the store, keeps `status=active` entries, filters by path glob, and
emits **all** matches (unbounded by default), **ranked most-relevant-first**:

1. path-specific matches before global (`[]`) entries;
2. within the path-specific tier, the **more specific matching glob first** (an
   exact-file learning outranks a deep glob, which outranks a broad catch-all);
3. then newer before older.

Each rendered bullet ends with **why it surfaced** — `(global)` for a
cross-cutting entry, otherwise the glob(s) that actually matched your `--paths`.
Nothing matches? You get **exit 0 and empty output** — callers must tolerate that.

```bash
# opt into a byte budget per page; walk lower-ranked entries with --page
learnings recall --paths src/app.ts --max-bytes 2000 --page 1

# raw entries instead of flat bullets
learnings recall --paths src/app.ts --format json
```

Both commands default to `.learnings.ndjson` in the cwd; pass `--file <path>` to
point elsewhere. For writes inside a worktree, `--target-file <abs>` overrides
`--file` so a stray write never lands in the wrong checkout.

## Layout 🗂️

```
CONTRACT.md             frozen storage + CLI API (what consumers depend on)
package.json            { "type": "module" }, zero runtime deps, Node >= 20
src/learnings-core.mjs  pure functions (parse/glob/match/rank/bound/render/dedup)
src/cli.mjs             recall | learn
scripts/test.sh         node --test tests/**/*.test.mjs
tests/*.test.mjs        core + CLI tests
skills/recall/SKILL.md  Claude Code front door -> recall
skills/learn/SKILL.md   Claude Code front door -> learn
```

The frozen API every consumer depends on is in [`CONTRACT.md`](./CONTRACT.md).

## Test ✅

```bash
./scripts/test.sh
```

## License 📜

MIT.

---

🫡 *Brought to you by an AI agent and a human who pressed Enter a lot.* 🫡
