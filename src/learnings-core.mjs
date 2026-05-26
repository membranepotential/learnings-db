// learnings-core.mjs — pure functions for the shared learnings recall/learn
// contract. NO I/O, NO process.exit, NO ambient state: every input is an
// explicit argument so each function is trivially unit-testable.
//
// The CLI (src/cli.mjs) and every front door (the /recall + /learn skills,
// /next, /ce-compound, a future MCP adapter) COMPOSE these functions — none
// reimplements parsing, dedup, scoping, or ranking. This module is the contract
// frozen in CONTRACT.md.

import { createHash } from 'node:crypto';

// --- dedup / identity ------------------------------------------------------

// Normalize a string for duplicate detection — lowercase, collapse runs of
// non-alphanumerics to a single space, trim. Ported verbatim from next's
// scripts/lib/drift.mjs (`normalizeForDedup`) so both systems agree on what
// "the same learning" is. Two texts differing only in whitespace, punctuation,
// or case normalize to the same string.
export function normalizeForDedup(s) {
	return String(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// Stable 12-char id: sha1 of the normalized text. Idempotent upsert key — the
// same learning, reworded only in punctuation/case, yields the same id.
export function entryId(text) {
	return createHash('sha1').update(normalizeForDedup(text)).digest('hex').slice(0, 12);
}

// Is `text` already represented among `entries` (by id)?
export function isDuplicate(text, entries) {
	const id = entryId(text);
	return (entries || []).some((e) => e && e.id === id);
}

// --- storage parsing -------------------------------------------------------

// Parse NDJSON text into entry objects. Blank / whitespace-only lines are
// skipped. A malformed line is skipped rather than thrown — a single bad line
// must not blind recall over a whole file. When `onError` is supplied it is
// called with (lineNo, rawLine, err) so a caller can warn.
export function parseEntries(text, { onError } = {}) {
	if (!text) return [];
	const out = [];
	const lines = String(text).split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch (err) {
			if (onError) onError(i + 1, lines[i], err);
		}
	}
	return out;
}

// --- glob matching ---------------------------------------------------------

// Translate a single glob into an anchored RegExp.
//   *   → any run of non-separator chars
//   **  → any run of chars including separators (trailing/standalone)
//   **/ → zero or more whole path segments (so a/**/b matches a/b and a/x/y/b)
//   ?   → a single non-separator char
// All other regex metacharacters are escaped literally.
function globToRegExp(glob) {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					re += '(?:[^/]+/)*'; // **/ — zero or more segments
					i += 2;
				} else {
					re += '.*'; // ** — anything, including separators
					i += 1;
				}
			} else {
				re += '[^/]*'; // * — within one segment
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^${}()|[]\\/'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	return new RegExp('^' + re + '$');
}

// Does `glob` match `path`? Leading "./" on either side is ignored so callers
// can pass repo-relative paths with or without it.
export function globMatch(glob, path) {
	if (typeof glob !== 'string' || typeof path !== 'string') return false;
	const g = glob.replace(/^\.\//, '');
	const p = path.replace(/^\.\//, '');
	return globToRegExp(g).test(p);
}

// --- filtering / ranking / bounding ---------------------------------------

// Does `entry` survive the recall filters? An entry with empty `paths` is
// "global" (cross-cutting) and matches every recall; a path-specific entry
// matches only when one of its globs hits a requested path.
//   - paths: requested files in scope; omit ⇒ only global ([]) entries match.
export function matchEntry(entry, { paths } = {}) {
	if (!entry) return false;
	const entryPaths = Array.isArray(entry.paths) ? entry.paths : [];
	if (entryPaths.length === 0) return true; // global / cross-cutting
	const reqPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
	if (reqPaths.length === 0) return false; // path-specific entry, nothing in scope
	return entryPaths.some((g) => reqPaths.some((p) => globMatch(g, p)));
}

// Specificity of a single glob: the length of its literal prefix up to the
// first wildcard (`*`/`?`). An exact path (no wildcard) scores its full length;
// `services/app/src/lib/**` scores ~20; a bare `**` scores 0. So an exact-file
// learning, and deeper/more-anchored globs, outrank broad catch-all globs that
// happen to also cover the file in scope.
export function globSpecificity(glob) {
	if (typeof glob !== 'string') return 0;
	const g = glob.replace(/^\.\//, '');
	const w = g.search(/[*?]/);
	return w === -1 ? g.length : w;
}

// Best (most specific) specificity among the entry's globs that match a
// requested path. Returns -1 when the entry is global ([]) or none match — that
// sentinel also marks the global tier, which ranks after every path-specific
// match.
function matchSpecificity(entry, reqPaths) {
	const ep = Array.isArray(entry.paths) ? entry.paths : [];
	let best = -1;
	for (const g of ep) {
		if (reqPaths.some((p) => globMatch(g, p))) best = Math.max(best, globSpecificity(g));
	}
	return best;
}

// Rank most-relevant-first — earlier in the list = more relevant, which is what
// the byte budget keeps when it truncates the tail. Order:
//   1. path-specific matches before global ([]) entries;
//   2. within the path-specific tier, the more specific matching glob first
//      (exact file > deep glob > broad `services/**` glob);
//   3. then newer date first.
// Stable (preserves input order for fully-tied entries). Non-mutating.
export function rankEntries(entries, { paths } = {}) {
	const reqPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
	return [...entries].sort((a, b) => {
		const sa = matchSpecificity(a, reqPaths);
		const sb = matchSpecificity(b, reqPaths);
		const ta = sa >= 0 ? 0 : 1; // path-specific tier (0) before global (1)
		const tb = sb >= 0 ? 0 : 1;
		if (ta !== tb) return ta - tb;
		if (ta === 0 && sa !== sb) return sb - sa; // more specific glob first
		const da = a.date || '';
		const db = b.date || '';
		if (da !== db) return da < db ? 1 : -1; // newer (lexically larger ISO date) first
		return 0;
	});
}

// One grouped-bullet line for an entry (the unit of both rendering and byte
// budgeting, so the budget reflects what is actually emitted). The trailing
// annotation states *why this learning surfaced* so the consumer can judge
// relevance: `(global)` for a cross-cutting ([]) entry, else the entry glob(s)
// that actually matched the requested paths — the matching rule, not the
// entry's full scope. When reqPaths is absent we can't compute a match, so we
// fall back to the entry's full scope.
function bulletLine(e, reqPaths) {
	const ep = Array.isArray(e.paths) ? e.paths : [];
	if (ep.length === 0) return `- ${e.text}  (global)`;
	const req = Array.isArray(reqPaths) ? reqPaths.filter(Boolean) : [];
	const matched = req.length ? ep.filter((g) => req.some((p) => globMatch(g, p))) : [];
	const shown = matched.length ? matched : ep;
	return `- ${e.text}  (${shown.join(', ')})`;
}

// Split entries (in the order given — rank first!) into successive pages, each
// holding as many entries as fit in `max` rendered bytes. Pages are disjoint
// and exhaustive, so a caller can walk page 1, 2, 3 … and never see the same
// learning twice — the point of pagination here. A single oversized entry still
// gets its own page (never silently dropped). `page` is 1-based and clamped into
// [1, pages]. max ≤ 0 / non-finite ⇒ a single page holding everything.
// Returns { entries, page, pages, total }. `paths` (the requested paths) is used
// only to size each line exactly as it will render (matching-rule annotation),
// so the byte budget reflects the real output.
export function paginateByBytes(entries, max, page = 1, { paths } = {}) {
	const list = Array.isArray(entries) ? entries : [];
	const total = list.length;
	if (total === 0) return { entries: [], page: 1, pages: 0, total: 0 };
	if (!Number.isFinite(max) || max <= 0) return { entries: [...list], page: 1, pages: 1, total };

	const bounds = []; // [start, end) per page
	let i = 0;
	while (i < total) {
		const start = i;
		let bytes = 0;
		while (i < total) {
			const size = Buffer.byteLength(bulletLine(list[i], paths) + '\n', 'utf8');
			if (bytes + size > max && i > start) break; // page full; always keep ≥1
			bytes += size;
			i++;
		}
		bounds.push([start, i]);
	}
	const pages = bounds.length;
	const p = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
	const [s, e] = bounds[p - 1];
	return { entries: list.slice(s, e), page: p, pages, total };
}

// Greedily keep entries whose cumulative rendered size stays within `max` bytes
// — i.e. the first page. Retained as the contract's single-slice helper; callers
// that page use paginateByBytes directly.
export function boundByBytes(entries, max) {
	return paginateByBytes(entries, max, 1).entries;
}

// Render entries as a flat bullet list for prompt injection, in the order given
// (rank order: most-specific match first, then newest). Each bullet carries its
// matching rule (the glob that matched `paths`, or `(global)`) so the consumer
// can judge relevance. Empty ⇒ "".
export function renderText(entries, { paths } = {}) {
	if (!entries || entries.length === 0) return '';
	return entries.map((e) => bulletLine(e, paths)).join('\n');
}

// --- entry construction ----------------------------------------------------

// Build a schema-complete entry from loose fields. `id` is derived from `text`.
// Missing optionals get their documented defaults (status "active", today's
// date). Throws when `text` is blank.
export function buildEntry({ text, paths, issue, pr, date, status } = {}) {
	if (!text || !String(text).trim()) throw new Error('buildEntry: text is required');
	const clean = String(text).trim();
	const provenance = {};
	if (issue != null && issue !== '') provenance.issue = Number(issue);
	if (pr != null && pr !== '') provenance.pr = Number(pr);
	return {
		id: entryId(clean),
		text: clean,
		paths: Array.isArray(paths) ? paths.filter(Boolean) : [],
		provenance,
		date: date || new Date().toISOString().slice(0, 10),
		status: status || 'active'
	};
}
