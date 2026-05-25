# learnings — shared `recall` + `learn`

One read/write contract over a queryable store of codebase-engineering learnings,
replacing the two divergent, hand-maintained attribution maps that `/ce-compound`
and `/next` kept over the same files. Recall returns **only the matching entries**
(token-bounded), scoped by **path-glob + phase**; writes go through one deduping,
correct-path implementation.

See [`learnings-recall-learn-PLAN.md`](./learnings-recall-learn-PLAN.md) for the
full design and [`CONTRACT.md`](./CONTRACT.md) for the frozen API.

## Layout

```
CONTRACT.md             frozen storage + CLI API (what consumers depend on)
package.json            { "type": "module" }, zero runtime deps, Node >= 20
src/learnings-core.mjs  pure functions (parse/glob/match/rank/bound/render/dedup/migrate)
src/cli.mjs             recall | learn | migrate
scripts/test.sh         node --test tests/**/*.test.mjs  (Node-20-safe glob)
tests/*.test.mjs        core + migration + CLI tests
skills/recall/SKILL.md  thin front door -> recall
skills/learn/SKILL.md   judgment front door -> learn
```

## Use

```bash
# capture a learning (dedupes on normalized text)
node src/cli.mjs learn --dir docs/learnings --area services-server \
  --text "Register handlers in routes.ts before the test file (vitest discovery fails cold)." \
  --paths "services/server/src/routes/**" --phase impl --kind gotcha

# recall what applies to the files you're about to touch
node src/cli.mjs recall --dir docs/learnings \
  --paths services/server/src/routes/foo.ts --phase impl

# one-time migrate a legacy <area>.md (non-destructive)
node src/cli.mjs migrate --md docs/learnings/services-server.md \
  --area services-server --registry CLAUDE.md
```

## Test

```bash
./scripts/test.sh
```

## Wire-up (per PLAN §6, §10–§11)

This repo delivers **build-order steps 1 and 3** — the engine + tests, and the
`/recall` + `/learn` skills. The remaining steps touch other projects:

1. ✅ Engine (`learnings-core.mjs` + `cli.mjs` recall/learn/migrate) + tests.
2. ⬜ `migrate` run on the target project's legacy `.md` files + human curation.
3. ✅ `/recall` + `/learn` skills.
4. ⬜ Rewire `/ce-compound` to call `learnings learn …` (keep its `CLAUDE.md`
   registry row) — low risk.
5. ⬜ Rewire `/next`: replace `pickLearningsFile` with `recall --paths … --phase …`,
   call `learn --target-dir <worktree-abs>/docs/learnings …` in the compound phase,
   retire the `.next/config.json` label map — **additive/flagged first, riskiest, last**.

To activate the skills, symlink them into `~/.claude/skills` and point consumers
at the CLI via a stable, configurable path (e.g. a `LEARNINGS_CLI` env var):

```bash
ln -s "$PWD/skills/recall" ~/.claude/skills/recall
ln -s "$PWD/skills/learn"  ~/.claude/skills/learn
```
