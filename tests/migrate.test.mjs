import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdBulletsToEntries } from '../src/learnings-core.mjs';

const find = (entries, needle) => entries.find((e) => e.text.includes(needle));

test('phase comes from [impl]/[planning] tags, else both', () => {
	const md = [
		'- **[impl]** Register handlers before the test file',
		'- [planning] Decide the migration order first',
		'- A plain untagged bullet'
	].join('\n');
	const { entries } = mdBulletsToEntries(md, { area: 'svc' });
	assert.equal(find(entries, 'Register handlers').phase, 'impl');
	assert.equal(find(entries, 'migration order').phase, 'planning');
	assert.equal(find(entries, 'plain untagged').phase, 'both');
});

test('tag markers and trailing date are stripped from text', () => {
	const md = '- **[impl]** Cold start fails (2026-05-25)';
	const { entries } = mdBulletsToEntries(md, { area: 'svc' });
	assert.equal(entries[0].text, 'Cold start fails');
	assert.equal(entries[0].phase, 'impl');
	assert.equal(entries[0].date, '2026-05-25');
});

test('inline backtick paths become entry.paths; non-path code does not', () => {
	const md = '- Put it in `services/server/src/routes/**` not in `await foo()`';
	const { entries } = mdBulletsToEntries(md, { area: 'svc' });
	assert.deepEqual(entries[0].paths, ['services/server/src/routes/**']);
});

test('registry paths are the fallback when no inline path', () => {
	const md = '- [impl] A cross-cutting note with no path';
	const { entries } = mdBulletsToEntries(md, { area: 'svc', registryPaths: ['services/server/**'] });
	assert.deepEqual(entries[0].paths, ['services/server/**']);
});

test('kind is inferred from the nearest preceding subsection heading', () => {
	const md = ['## Gotchas', '- a gotcha bullet', '## Patterns', '- a pattern bullet'].join('\n');
	const { entries } = mdBulletsToEntries(md, { area: 'svc' });
	assert.equal(find(entries, 'gotcha bullet').kind, 'gotcha');
	assert.equal(find(entries, 'pattern bullet').kind, 'pattern');
});

test('low-confidence rows (no inline path AND no tag) are flagged', () => {
	const md = ['- [impl] tagged, scoping ok by phase', '- plain bullet, no path no tag'].join('\n');
	const { entries, flagged } = mdBulletsToEntries(md, { area: 'svc' });
	assert.equal(entries.length, 2);
	assert.equal(flagged.length, 1);
	assert.match(flagged[0].text, /plain bullet/);
});

test('date falls back to opts.date when no trailing date present', () => {
	const md = '- a bullet';
	const { entries } = mdBulletsToEntries(md, { area: 'svc', date: '2026-05-25' });
	assert.equal(entries[0].date, '2026-05-25');
});
