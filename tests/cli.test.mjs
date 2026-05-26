import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntries } from '../src/learnings-core.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const run = (args, opts = {}) =>
	execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
const tmp = () => mkdtempSync(join(tmpdir(), 'learnings-'));
const store = () => join(tmp(), 'learnings.ndjson'); // a fresh store file path

test('learn appends a deduped entry; second identical learn is a no-op', () => {
	const file = store();
	const out1 = run(['learn', '--file', file, '--text', 'Cold start fails', '--paths', 'src/routes/**']);
	assert.match(out1, /^added [0-9a-f]{12}\n$/);

	const out2 = run(['learn', '--file', file, '--text', 'cold  start, FAILS!']);
	assert.match(out2, /^duplicate [0-9a-f]{12}\n$/);

	const lines = parseEntries(readFileSync(file, 'utf8'));
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0].paths, ['src/routes/**']);
});

test('--target-file overrides --file for the write (worktree rule)', () => {
	const a = store();
	const b = store();
	run(['learn', '--file', a, '--target-file', b, '--text', 'goes to b']);
	assert.equal(existsSync(a), false);
	assert.equal(existsSync(b), true);
});

test('learn creates the store file and its parent dir if missing', () => {
	const file = join(tmp(), 'nested', 'deep', '.learnings.ndjson');
	run(['learn', '--file', file, '--text', 'a note']);
	assert.equal(existsSync(file), true);
});

test('recall filters by path scope and renders bullets', () => {
	const file = store();
	run(['learn', '--file', file, '--text', 'route gotcha', '--paths', 'src/routes/**']);
	run(['learn', '--file', file, '--text', 'cross cutting note']); // global ([])
	run(['learn', '--file', file, '--text', 'other area note', '--paths', 'src/other/**']);

	const out = run(['recall', '--file', file, '--paths', 'src/routes/a.ts']);
	assert.match(out, /route gotcha/);
	assert.match(out, /cross cutting note/); // global always in scope
	assert.doesNotMatch(out, /other area note/); // path out of scope
});

test('recall --format json emits the matched entries; empty matches → empty output, exit 0', () => {
	const file = store();
	run(['learn', '--file', file, '--text', 'a note', '--paths', 'src/a.ts']);
	const json = JSON.parse(run(['recall', '--file', file, '--paths', 'src/a.ts', '--format', 'json']));
	assert.equal(json.length, 1);
	assert.equal(json[0].text, 'a note');

	const empty = run(['recall', '--file', file, '--paths', 'nowhere/x.ts']);
	assert.equal(empty, '');
});

test('recall is unbounded by default: all matched returned, no pagination note', () => {
	const file = store();
	for (let i = 0; i < 12; i++) {
		run(['learn', '--file', file, '--text', `learning number ${i} ` + 'x'.repeat(80), '--paths', 'src/a.ts']);
	}
	const r = spawnSync('node', [CLI, 'recall', '--file', file, '--paths', 'src/a.ts'], { encoding: 'utf8' });
	assert.equal(r.status, 0);
	assert.equal((r.stdout.match(/^- /gm) || []).length, 12); // every matched bullet, no byte cap
	assert.equal(r.stderr, ''); // unbounded ⇒ single page ⇒ no note
});

test('recall annotates the matching rule and labels globals', () => {
	const file = store();
	run(['learn', '--file', file, '--text', 'review gotcha', '--paths', 'src/review/**,src/e2e/**']);
	run(['learn', '--file', file, '--text', 'cross cutting note']); // global
	const out = run(['recall', '--file', file, '--paths', 'src/review/Thing.tsx']);
	assert.match(out, /- review gotcha {2}\(src\/review\/\*\*\)/); // only the matched glob
	assert.doesNotMatch(out, /e2e/); // non-matching glob hidden
	assert.match(out, /- cross cutting note {2}\(global\)/);
});

test('recall paginates only when --max-bytes is set: stderr note, disjoint pages, pure stdout', () => {
	const file = store();
	for (let i = 0; i < 5; i++) {
		run(['learn', '--file', file, '--text', `padding learning ${i} ` + 'x'.repeat(100), '--paths', 'src/a.ts']);
	}
	const p1 = spawnSync('node', [CLI, 'recall', '--file', file, '--paths', 'src/a.ts', '--max-bytes', '120'], { encoding: 'utf8' });
	assert.equal(p1.status, 0);
	assert.match(p1.stderr, /page 1\/5, showing 1 of 5 matched learning\(s\), most relevant first\. Re-run with --page 2/);
	assert.doesNotMatch(p1.stdout, /note:/); // the note never leaks into consumable output

	// page 2 is a different, non-overlapping slice
	const p2 = spawnSync('node', [CLI, 'recall', '--file', file, '--paths', 'src/a.ts', '--max-bytes', '120', '--page', '2'], { encoding: 'utf8' });
	assert.match(p2.stderr, /page 2\/5/);
	assert.notEqual(p1.stdout, p2.stdout);

	// last page says so, no "next page"
	const p5 = spawnSync('node', [CLI, 'recall', '--file', file, '--paths', 'src/a.ts', '--max-bytes', '120', '--page', '5'], { encoding: 'utf8' });
	assert.match(p5.stderr, /page 5\/5.*\(last page\)/);
});

test('recall writes no note when the whole matched set fits one page', () => {
	const file = store();
	run(['learn', '--file', file, '--text', 'small note', '--paths', 'src/a.ts']);
	const r = spawnSync('node', [CLI, 'recall', '--file', file, '--paths', 'src/a.ts'], { encoding: 'utf8' });
	assert.equal(r.status, 0);
	assert.equal(r.stderr, '');
});

test('recall on a missing store file is empty + exit 0 (callers tolerate empty)', () => {
	const out = run(['recall', '--file', join(tmpdir(), 'does-not-exist-' + Date.now() + '.ndjson')]);
	assert.equal(out, '');
});
