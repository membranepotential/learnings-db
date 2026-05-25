import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntries } from '../src/learnings-core.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const run = (args, opts = {}) =>
	execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
const tmp = () => mkdtempSync(join(tmpdir(), 'learnings-'));

test('learn appends a deduped entry; second identical learn is a no-op', () => {
	const dir = tmp();
	const out1 = run(['learn', '--dir', dir, '--area', 'svc', '--text', 'Cold start fails', '--paths', 'src/routes/**']);
	assert.match(out1, /^added [0-9a-f]{12}\n$/);

	const out2 = run(['learn', '--dir', dir, '--area', 'svc', '--text', 'cold  start, FAILS!']);
	assert.match(out2, /^duplicate [0-9a-f]{12}\n$/);

	const lines = parseEntries(readFileSync(join(dir, 'svc.ndjson'), 'utf8'));
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0].paths, ['src/routes/**']);
});

test('--target-dir overrides --dir for the write (worktree rule)', () => {
	const a = tmp();
	const b = tmp();
	run(['learn', '--dir', a, '--target-dir', b, '--area', 'svc', '--text', 'goes to b']);
	assert.equal(existsSync(join(a, 'svc.ndjson')), false);
	assert.equal(existsSync(join(b, 'svc.ndjson')), true);
});

test('recall filters by path scope and renders grouped bullets', () => {
	const dir = tmp();
	run(['learn', '--dir', dir, '--area', 'svc', '--text', 'route gotcha', '--paths', 'src/routes/**']);
	run(['learn', '--dir', dir, '--area', 'svc', '--text', 'cross cutting note']); // area-wide
	run(['learn', '--dir', dir, '--area', 'svc', '--text', 'other area note', '--paths', 'src/other/**']);

	const out = run(['recall', '--dir', dir, '--paths', 'src/routes/a.ts']);
	assert.match(out, /route gotcha/);
	assert.match(out, /cross cutting note/); // area-wide always in scope
	assert.doesNotMatch(out, /other area note/); // path out of scope
});

test('recall --format json emits the matched entries; empty matches → empty output, exit 0', () => {
	const dir = tmp();
	run(['learn', '--dir', dir, '--area', 'svc', '--text', 'a note', '--paths', 'src/a.ts']);
	const json = JSON.parse(run(['recall', '--dir', dir, '--paths', 'src/a.ts', '--format', 'json']));
	assert.equal(json.length, 1);
	assert.equal(json[0].text, 'a note');

	const empty = run(['recall', '--dir', dir, '--paths', 'nowhere/x.ts']);
	assert.equal(empty, '');
});

test('recall on a missing dir is empty + exit 0 (callers tolerate empty)', () => {
	const out = run(['recall', '--dir', join(tmpdir(), 'does-not-exist-' + Date.now())]);
	assert.equal(out, '');
});

test('migrate writes ndjson next to the md, non-destructively', () => {
	const dir = tmp();
	const md = join(dir, 'svc.md');
	writeFileSync(md, ['## Gotchas', '- **[impl]** Register handlers in `src/routes/**`'].join('\n'));
	const out = run(['migrate', '--md', md, '--area', 'svc']);
	assert.match(out, /migrated 1 entry/);
	assert.equal(existsSync(md), true); // original kept
	const entries = parseEntries(readFileSync(join(dir, 'svc.ndjson'), 'utf8'));
	assert.deepEqual(entries[0].paths, ['src/routes/**']);
	assert.ok(!('phase' in entries[0]) && !('kind' in entries[0])); // dropped from the contract
});

test('migrate --blame fills candidate paths from the bullet\'s introducing commit', () => {
	const dir = tmp();
	const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 't@example.com');
	git('config', 'user.name', 'Test');

	// One commit that ships a code change AND its learning bullet together — the
	// compound-with-code pattern blame is meant to exploit.
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'routes.ts'), 'export const routes = [];\n');
	writeFileSync(join(dir, 'svc.md'), ['# Learnings', '', '- A subtle ordering gotcha with no inline path'].join('\n'));
	git('add', '-A');
	git('commit', '-q', '-m', 'feat: routes + learning');

	run(['migrate', '--md', join(dir, 'svc.md'), '--area', 'svc', '--blame', '--out', join(dir, 'svc.ndjson')]);
	const entries = parseEntries(readFileSync(join(dir, 'svc.ndjson'), 'utf8'));
	assert.deepEqual(entries[0].paths, ['src/routes.ts']); // blame candidate, .md excluded
});
