import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeForDedup,
	entryId,
	isDuplicate,
	parseEntries,
	globMatch,
	matchEntry,
	globSpecificity,
	rankEntries,
	paginateByBytes,
	boundByBytes,
	renderText,
	buildEntry
} from '../src/learnings-core.mjs';

test('normalizeForDedup collapses case/punctuation/whitespace', () => {
	assert.equal(normalizeForDedup('Register   handlers, in routes.ts!'), 'register handlers in routes ts');
	assert.equal(normalizeForDedup('Foo. Bar'), normalizeForDedup('foo bar'));
});

test('entryId is stable across cosmetic differences and 12 chars', () => {
	const a = entryId('Register handlers in routes.ts');
	const b = entryId('register   handlers, in  routes.ts!!!');
	assert.equal(a, b);
	assert.equal(a.length, 12);
});

test('isDuplicate matches by normalized id', () => {
	const entries = [buildEntry({ text: 'Always check null', date: '2026-01-01' })];
	assert.equal(isDuplicate('ALWAYS   check, null', entries), true);
	assert.equal(isDuplicate('something else', entries), false);
});

test('parseEntries skips blank and malformed lines', () => {
	const calls = [];
	const text = '{"id":"a"}\n\n  \nnot json\n{"id":"b"}\n';
	const entries = parseEntries(text, { onError: (n, l) => calls.push([n, l]) });
	assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], 4); // line number of the bad line
});

test('globMatch: * stays within a segment', () => {
	assert.equal(globMatch('src/*.ts', 'src/a.ts'), true);
	assert.equal(globMatch('src/*.ts', 'src/sub/a.ts'), false);
});

test('globMatch: trailing ** crosses segments', () => {
	assert.equal(globMatch('services/server/src/routes/**', 'services/server/src/routes/a.ts'), true);
	assert.equal(globMatch('services/server/src/routes/**', 'services/server/src/routes/sub/b.ts'), true);
	assert.equal(globMatch('services/server/src/routes/**', 'services/server/src/other/b.ts'), false);
});

test('globMatch: **/ matches zero or more segments', () => {
	assert.equal(globMatch('a/**/b.ts', 'a/b.ts'), true);
	assert.equal(globMatch('a/**/b.ts', 'a/x/b.ts'), true);
	assert.equal(globMatch('a/**/b.ts', 'a/x/y/b.ts'), true);
	assert.equal(globMatch('a/**/b.ts', 'a/x/c.ts'), false);
});

test('globMatch: leading ./ is ignored, ? is single char', () => {
	assert.equal(globMatch('./src/a.ts', 'src/a.ts'), true);
	assert.equal(globMatch('src/a.ts', './src/a.ts'), true);
	assert.equal(globMatch('src/?.ts', 'src/a.ts'), true);
	assert.equal(globMatch('src/?.ts', 'src/ab.ts'), false);
});

test('matchEntry: global entry ([]) matches regardless of paths', () => {
	const e = { paths: [] };
	assert.equal(matchEntry(e, {}), true);
	assert.equal(matchEntry(e, { paths: ['anything.ts'] }), true);
});

test('matchEntry: path-specific entry needs a path in scope', () => {
	const e = { paths: ['src/routes/**'] };
	assert.equal(matchEntry(e, {}), false); // no paths in scope
	assert.equal(matchEntry(e, { paths: ['src/routes/a.ts'] }), true);
	assert.equal(matchEntry(e, { paths: ['src/other/a.ts'] }), false);
});

test('rankEntries: path-specific before global ([]), then newer first', () => {
	const globalOld = { paths: [], date: '2025-01-01', text: 'g-old' };
	const globalNew = { paths: [], date: '2026-05-01', text: 'g-new' };
	const specificOld = { paths: ['src/a.ts'], date: '2024-01-01', text: 'sp-old' };
	const specificNew = { paths: ['src/a.ts'], date: '2026-01-01', text: 'sp-new' };
	const ranked = rankEntries([globalOld, specificOld, globalNew, specificNew], { paths: ['src/a.ts'] });
	assert.deepEqual(ranked.map((e) => e.text), ['sp-new', 'sp-old', 'g-new', 'g-old']);
});

test('globSpecificity: literal prefix length; exact path > deep glob > broad', () => {
	assert.ok(globSpecificity('a/b/c.ts') > globSpecificity('a/b/**'));
	assert.ok(globSpecificity('a/b/**') > globSpecificity('a/**'));
	assert.ok(globSpecificity('a/**') > globSpecificity('**'));
	assert.equal(globSpecificity('**'), 0);
	assert.equal(globSpecificity('./a/b.ts'), globSpecificity('a/b.ts')); // leading ./ ignored
});

test('rankEntries: a more specific matching glob outranks a broad one (same date)', () => {
	const d = '2026-01-01';
	const broad = { paths: ['services/app/src/lib/**'], date: d, text: 'broad' };
	const exact = { paths: ['services/app/src/lib/components/Foo.svelte'], date: d, text: 'exact' };
	const deep = { paths: ['services/app/src/lib/components/**'], date: d, text: 'deep' };
	const ranked = rankEntries([broad, exact, deep], { paths: ['services/app/src/lib/components/Foo.svelte'] });
	assert.deepEqual(ranked.map((e) => e.text), ['exact', 'deep', 'broad']);
});

test('rankEntries: specificity beats recency within the path-specific tier', () => {
	const broadNew = { paths: ['src/**'], date: '2026-05-01', text: 'broad-new' };
	const exactOld = { paths: ['src/a/b.ts'], date: '2024-01-01', text: 'exact-old' };
	const ranked = rankEntries([broadNew, exactOld], { paths: ['src/a/b.ts'] });
	assert.deepEqual(ranked.map((e) => e.text), ['exact-old', 'broad-new']);
});

test('paginateByBytes: disjoint, exhaustive, ordered pages; clamps page', () => {
	const entries = [
		{ text: 'a'.repeat(50), paths: [] },
		{ text: 'b'.repeat(50), paths: [] },
		{ text: 'c'.repeat(50), paths: [] }
	];
	const max = 60; // one ~53-byte bullet per page
	const p1 = paginateByBytes(entries, max, 1);
	const p2 = paginateByBytes(entries, max, 2);
	const p3 = paginateByBytes(entries, max, 3);
	assert.equal(p1.pages, 3);
	assert.equal(p1.total, 3);
	assert.deepEqual([p1.entries[0].text[0], p2.entries[0].text[0], p3.entries[0].text[0]], ['a', 'b', 'c']);
	assert.equal(p1.entries.length + p2.entries.length + p3.entries.length, 3); // exhaustive, no overlap
	// page clamps into range
	assert.equal(paginateByBytes(entries, max, 99).page, 3);
	assert.equal(paginateByBytes(entries, max, 0).page, 1);
	// no bound ⇒ single page with everything
	const all = paginateByBytes(entries, 0, 1);
	assert.deepEqual([all.pages, all.entries.length], [1, 3]);
	// empty input
	assert.deepEqual(paginateByBytes([], 100, 1), { entries: [], page: 1, pages: 0, total: 0 });
});

test('paginateByBytes: an oversized entry gets its own whole page (never split)', () => {
	const entries = [{ text: 'x'.repeat(500), paths: [] }, { text: 'small', paths: [] }];
	const p1 = paginateByBytes(entries, 50, 1);
	assert.equal(p1.entries.length, 1); // the oversized one, whole
	assert.equal(p1.entries[0].text.length, 500); // not truncated
	assert.equal(p1.pages, 2);
});

test('boundByBytes: respects budget but never returns empty for non-empty input', () => {
	const entries = [
		{ text: 'x'.repeat(50), paths: [] },
		{ text: 'y'.repeat(50), paths: [] },
		{ text: 'z'.repeat(50), paths: [] }
	];
	assert.equal(boundByBytes(entries, 60).length, 1); // only the first fits
	assert.equal(boundByBytes(entries, 1).length, 1); // oversized first still returned
	assert.equal(boundByBytes(entries, 100000).length, 3); // generous budget keeps all
	assert.equal(boundByBytes([], 100).length, 0);
});

test('renderText: flat bullets with a path hint, in input order', () => {
	const out = renderText([
		{ text: 'cold start fails', paths: ['src/routes/**'] },
		{ text: 'plan for migrations', paths: [] }
	]);
	assert.doesNotMatch(out, /^##/m); // no area headers anymore
	assert.match(out, /- cold start fails {2}\(src\/routes\/\*\*\)/);
	assert.match(out, /- plan for migrations/);
});

test('buildEntry: defaults, provenance, derived id, and no phase/kind/area', () => {
	const e = buildEntry({ text: '  trim me  ', issue: '477', pr: '485', date: '2026-05-25' });
	assert.equal(e.text, 'trim me');
	assert.equal(e.status, 'active');
	assert.deepEqual(e.paths, []);
	assert.deepEqual(e.provenance, { issue: 477, pr: 485 });
	assert.equal(e.id, entryId('trim me'));
	assert.ok(!('phase' in e) && !('kind' in e) && !('area' in e), 'phase/kind/area are not part of the schema');
	assert.throws(() => buildEntry({ text: '   ' }));
});
