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

The `learnings` bin is the stable entry point (a symlink to `src/cli.mjs` on PATH).

```bash
# capture a learning (dedupes on normalized text)
learnings learn --dir docs/learnings --area services-server \
  --text "Register handlers in routes.ts before the test file (vitest discovery fails cold)." \
  --paths "services/server/src/routes/**"

# recall what applies to the files you're about to touch
learnings recall --dir docs/learnings --paths services/server/src/routes/foo.ts

# one-time migrate a legacy <area>.md (non-destructive)
learnings migrate --md docs/learnings/services-server.md \
  --area services-server --registry CLAUDE.md
```

## Test

```bash
./scripts/test.sh
```

## Wire-up (per PLAN §6, §10–§11)

1. ✅ Engine (`learnings-core.mjs` + `cli.mjs` recall/learn/migrate) + tests.
2. ◐ `migrate` (engine ready, incl. `--blame` path-candidate inference); still
   needs a run on the target project's legacy `.md` files + the agent/human
   tightening pass that narrows blame candidates to precise globs.
3. ✅ `/recall` + `/learn` skills.
4. ✅ `/ce-compound` mirrors each bullet into the store via `learnings learn`
   (additive, alongside its `.md` append + `CLAUDE.md` registry row).
   `/ce-plan` + `/ce-review` prefer scoped `recall`, falling back to the registry.
5. ✅ `/next`: the picker attaches scoped `recalledLearnings` and the compound
   phase mirrors via `learnings learn --target-dir …`. **Additive + behind
   `cfg.recall.enabled` (default off)** so the live autopilot is unchanged until
   a project opts in; the `.next/config.json` label map is retired once parity is
   confirmed.

> The integration edits live in `~/.claude/skills/{next,ce-compound,ce-plan,ce-review}`,
> which is not a git repo — they are not version-controlled by this project.

Activation (already done in this environment):

```bash
ln -sfn "$PWD/skills/recall" ~/.claude/skills/recall   # /recall skill
ln -sfn "$PWD/skills/learn"  ~/.claude/skills/learn    # /learn skill
ln -sfn "$PWD/src/cli.mjs"   ~/.local/bin/learnings    # `learnings` on PATH
```
