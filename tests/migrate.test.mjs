import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdBulletsToEntries, parseBlameCommit, commitFilesToCandidates } from '../src/learnings-core.mjs';

test('legacy [impl]/[planning] markers and trailing date are stripped from text', () => {
	const md = '- **[impl]** Cold start fails (2026-05-25)';
	const { entries } = mdBulletsToEntries(md);
	assert.equal(entries[0].text, 'Cold start fails');
	assert.equal(entries[0].date, '2026-05-25');
	assert.ok(!('phase' in entries[0]) && !('kind' in entries[0]) && !('area' in entries[0]));
});

test('headings are skipped, bullets under them still parse', () => {
	const md = ['## Gotchas', '- a gotcha bullet', '## Patterns', '- a pattern bullet'].join('\n');
	const { entries } = mdBulletsToEntries(md);
	assert.deepEqual(entries.map((e) => e.text), ['a gotcha bullet', 'a pattern bullet']);
});

test('inline backtick paths become entry.paths; non-path code does not', () => {
	const md = '- Put it in `services/server/src/routes/**` not in `await foo()`';
	const { entries } = mdBulletsToEntries(md);
	assert.deepEqual(entries[0].paths, ['services/server/src/routes/**']);
});

test('a bullet with no inline path is left global ([])', () => {
	const md = '- A cross-cutting note with no path';
	const { entries } = mdBulletsToEntries(md);
	assert.deepEqual(entries[0].paths, []);
});

test('low-confidence rows (no inline path) are flagged with their source line', () => {
	const md = ['# Learnings', '', '- has a path `src/a.ts`', '- plain bullet, no path'].join('\n');
	const { entries, flagged } = mdBulletsToEntries(md);
	assert.equal(entries.length, 2);
	assert.equal(flagged.length, 1);
	assert.match(flagged[0].text, /plain bullet/);
	assert.equal(flagged[0].line, 4); // 1-based line of the flagged bullet
});

test('parseBlameCommit: SHA from the first porcelain line, else null', () => {
	const porcelain = 'a1b2c3d4e5f6 12 12 1\nauthor Jane\n\tthe original line';
	assert.equal(parseBlameCommit(porcelain), 'a1b2c3d4e5f6');
	assert.equal(parseBlameCommit(''), null);
	assert.equal(parseBlameCommit('not-a-sha line'), null);
});

test('commitFilesToCandidates: drops blanks and excluded paths', () => {
	const nameOnly = '\nsrc/routes.ts\ndocs/learnings/svc.md\nsvc.md\nsrc/routes.ts\nREADME.md';
	const cands = commitFilesToCandidates(nameOnly, { exclude: ['docs/learnings/**', 'svc.md', '*.md'] });
	assert.deepEqual(cands, ['src/routes.ts']); // deduped, md + learnings excluded
});

test('date falls back to opts.date when no trailing date present', () => {
	const md = '- a bullet';
	const { entries } = mdBulletsToEntries(md, { date: '2026-05-25' });
	assert.equal(entries[0].date, '2026-05-25');
});
