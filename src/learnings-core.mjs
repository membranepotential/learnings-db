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
// "area-wide" (cross-cutting) and matches whenever its area is in scope; a
// path-specific entry matches only when one of its globs hits a requested path.
//   - phase: kept when entry.phase === req, entry.phase === "both", or untagged.
//   - area:  optional extra filter (exact match on entry.area).
//   - paths: requested files in scope; omit ⇒ only area-wide entries match.
export function matchEntry(entry, { paths, phase, area } = {}) {
	if (!entry) return false;
	if (phase && entry.phase && entry.phase !== phase && entry.phase !== 'both') return false;
	if (area && entry.area !== area) return false;
	const entryPaths = Array.isArray(entry.paths) ? entry.paths : [];
	if (entryPaths.length === 0) return true; // area-wide / cross-cutting
	const reqPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
	if (reqPaths.length === 0) return false; // path-specific entry, nothing in scope
	return entryPaths.some((g) => reqPaths.some((p) => globMatch(g, p)));
}

// Is this entry path-specific AND matched by one of the requested paths?
function isPathSpecificMatch(entry, reqPaths) {
	const ep = Array.isArray(entry.paths) ? entry.paths : [];
	return ep.length > 0 && reqPaths.some((p) => ep.some((g) => globMatch(g, p)));
}

// Rank: path-specific matches before area-wide; within a tier, newer date
// first. Stable (preserves input order for fully-tied entries). Non-mutating.
export function rankEntries(entries, { paths } = {}) {
	const reqPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
	return [...entries].sort((a, b) => {
		const sa = isPathSpecificMatch(a, reqPaths) ? 0 : 1;
		const sb = isPathSpecificMatch(b, reqPaths) ? 0 : 1;
		if (sa !== sb) return sa - sb;
		const da = a.date || '';
		const db = b.date || '';
		if (da !== db) return da < db ? 1 : -1; // newer (lexically larger ISO date) first
		return 0;
	});
}

// One grouped-bullet line for an entry (the unit of both rendering and byte
// budgeting, so the budget reflects what is actually emitted).
function bulletLine(e) {
	const phaseTag = e.phase && e.phase !== 'both' ? `[${e.phase}] ` : '';
	const ep = Array.isArray(e.paths) ? e.paths : [];
	const where = ep.length ? `  (${ep.join(', ')})` : '';
	return `- ${phaseTag}${e.text}${where}`;
}

// Greedily keep entries (in the order given — rank first!) whose cumulative
// rendered size stays within `max` bytes. Always returns at least the first
// entry when the input is non-empty, so a single oversized-but-relevant
// learning is never silently dropped. max ≤ 0 / non-finite ⇒ no bound.
export function boundByBytes(entries, max) {
	if (!Array.isArray(entries) || entries.length === 0) return [];
	if (!Number.isFinite(max) || max <= 0) return [...entries];
	const out = [];
	let total = 0;
	for (const e of entries) {
		const size = Buffer.byteLength(bulletLine(e) + '\n', 'utf8');
		if (total + size > max && out.length > 0) break;
		out.push(e);
		total += size;
	}
	return out;
}

// Render entries as grouped bullets for prompt injection — one "## <area>"
// header per area, bullets in the order given (rank order). Empty ⇒ "".
export function renderText(entries) {
	if (!entries || entries.length === 0) return '';
	const byArea = new Map();
	for (const e of entries) {
		const a = e.area || '(unknown)';
		if (!byArea.has(a)) byArea.set(a, []);
		byArea.get(a).push(e);
	}
	const blocks = [];
	for (const [area, list] of byArea) {
		const lines = [`## ${area}`];
		for (const e of list) lines.push(bulletLine(e));
		blocks.push(lines.join('\n'));
	}
	return blocks.join('\n\n');
}

// --- entry construction ----------------------------------------------------

// Build a schema-complete entry from loose fields. `id` is derived from `text`.
// Missing optionals get their documented defaults (phase "both", status
// "active", today's date). Throws when `text` is blank.
export function buildEntry({ text, paths, phase, area, kind, issue, pr, date, status } = {}) {
	if (!text || !String(text).trim()) throw new Error('buildEntry: text is required');
	const clean = String(text).trim();
	const provenance = {};
	if (issue != null && issue !== '') provenance.issue = Number(issue);
	if (pr != null && pr !== '') provenance.pr = Number(pr);
	return {
		id: entryId(clean),
		text: clean,
		paths: Array.isArray(paths) ? paths.filter(Boolean) : [],
		phase: phase || 'both',
		area: area || null,
		kind: kind || null,
		provenance,
		date: date || new Date().toISOString().slice(0, 10),
		status: status || 'active'
	};
}

// --- migration (.md bullets → entries) -------------------------------------

const KIND_PATTERNS = [
	[/gotcha/i, 'gotcha'],
	[/pattern/i, 'pattern'],
	[/decision/i, 'decision']
];

function inferKind(heading) {
	if (!heading) return null;
	for (const [re, kind] of KIND_PATTERNS) if (re.test(heading)) return kind;
	return null;
}

function inferPhase(raw) {
	if (/\[planning\]/i.test(raw)) return 'planning';
	if (/\[impl\]/i.test(raw)) return 'impl';
	return 'both';
}

function inferDate(raw) {
	const m = raw.match(/\((\d{4}-\d{2}-\d{2})[^)]*\)\s*$/);
	return m ? m[1] : null;
}

function looksLikePath(tok) {
	if (!tok || /\s/.test(tok)) return false;
	if (tok.includes('**')) return true;
	if (tok.includes('/')) return true;
	return /\.[a-z0-9]{1,5}$/i.test(tok); // bare filename with extension
}

function extractInlinePaths(raw) {
	const out = [];
	const backtick = /`([^`]+)`/g;
	let m;
	while ((m = backtick.exec(raw))) {
		const tok = m[1].trim();
		if (looksLikePath(tok)) out.push(tok);
	}
	return out;
}

function cleanBulletText(raw) {
	return raw
		.replace(/^\s*[-*]\s+/, '')
		.replace(/\*\*\[(planning|impl)\]\*\*/gi, '')
		.replace(/\[(planning|impl)\]/gi, '')
		.replace(/\((\d{4}-\d{2}-\d{2})[^)]*\)\s*$/, '')
		.trim();
}

// Best-effort migration of a legacy learnings .md into entries. Each top-level
// bullet becomes one entry:
//   - phase  ← [planning]/[impl] tag, else "both"
//   - paths  ← inline backtick paths in the bullet, else `registryPaths`, else []
//   - kind   ← nearest preceding subsection heading (gotcha/pattern/decision)
//   - date   ← trailing (YYYY-MM-DD) if present, else opts.date
// Returns { entries, flagged }; `flagged` lists rows whose scoping was inferred
// (no inline path AND no phase tag) for a human curation pass. Non-destructive:
// reads the markdown, writes nothing.
export function mdBulletsToEntries(md, opts = {}) {
	const { area = null, registryPaths = [], date: defaultDate = null } = opts;
	const entries = [];
	const flagged = [];
	let heading = null;
	for (const raw of String(md || '').split('\n')) {
		const h = raw.match(/^#{1,6}\s+(.*)$/);
		if (h) {
			heading = h[1].trim();
			continue;
		}
		if (!/^\s*[-*]\s+/.test(raw)) continue;
		const text = cleanBulletText(raw);
		if (!text) continue;
		const phase = inferPhase(raw);
		const inline = extractInlinePaths(raw);
		let paths = inline;
		let pathSource = 'inline';
		if (paths.length === 0) {
			if (registryPaths && registryPaths.length) {
				paths = [...registryPaths];
				pathSource = 'registry';
			} else {
				pathSource = 'none';
			}
		}
		const date = inferDate(raw) || defaultDate || undefined;
		const entry = buildEntry({ text, paths, phase, area, kind: inferKind(heading), date });
		entries.push(entry);
		if (pathSource !== 'inline' && phase === 'both') {
			flagged.push({ id: entry.id, text, reason: 'scoping inferred (no inline path, no phase tag)' });
		}
	}
	return { entries, flagged };
}
