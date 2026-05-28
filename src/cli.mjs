#!/usr/bin/env node
// learnings CLI — the thin shell over learnings-core.mjs. Three commands:
//   recall  — read the store file, filter/rank/paginate, emit bullets|json
//   learn   — append one deduped entry to the store file
//   forget  — soft-delete (status→deprecated) or --purge one entry by id/text
//
// Project-agnostic: recall/learn take --file <learnings.ndjson> (default
// .learnings.ndjson in the cwd). All logic lives in learnings-core; this file
// only does argv parsing and file I/O.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	parseEntries,
	matchEntry,
	rankEntries,
	paginateByBytes,
	renderText,
	buildEntry,
	isDuplicate,
	entryId,
	forgetEntry
} from './learnings-core.mjs';

const HELP = `learnings — shared recall/learn over a path-scoped NDJSON learnings store

Usage:
  learnings recall  [--file <learnings.ndjson>] [--paths a,b]
                    [--max-bytes N] [--page 1] [--format text|json]
  learnings learn   --text "..." [--file <learnings.ndjson>] [--paths a/**,b.ts]
                    [--issue N] [--pr N] [--date YYYY-MM-DD]
                    [--target-file <abs>] [--allow-dup]
  learnings forget  (--id <id> | --text "...") [--file <learnings.ndjson>]
                    [--target-file <abs>] [--purge]

--file defaults to .learnings.ndjson in the current directory. Set
$LEARNINGS_STORE to redirect all commands at one store (it overrides --file but
not --target-file) — used to keep worktree/CI writes off the wrong checkout.
forget soft-deletes by default (status→deprecated; the line is kept for
provenance, recall ignores it). Pass --purge to remove the line outright.
recall is unbounded by default (all matched, ranked most-relevant first); pass a
positive --max-bytes to bound output into pages and page through with --page.

Run a command with no required flags to see its error, or 'learnings help'.
`;

function fail(msg) {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(2);
}

// Minimal "--flag value" / "--bool" parser. A flag with no following value (or
// followed by another --flag) is treated as boolean true.
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			args[key] = true;
		} else {
			args[key] = next;
			i++;
		}
	}
	return args;
}

// The store is a single NDJSON file. Default: .learnings.ndjson in the cwd.
const DEFAULT_STORE = '.learnings.ndjson';

const str = (v) => (typeof v === 'string' && v ? v : undefined);

// Resolve which store file a command reads/writes. Precedence:
//   --target-file  (explicit per-call override — "write exactly here")
//   $LEARNINGS_STORE  (redirect for worktree/CI setups — e.g. /next trunk mode
//                      points this at the integration worktree's store so a bare
//                      `learnings learn` can't strand on the wrong checkout; it
//                      deliberately beats a relative --file so recall and learn
//                      both hit the same store)
//   --file         (per-call store path)
//   DEFAULT_STORE  (.learnings.ndjson in the cwd)
function resolveStore(args) {
	return (
		str(args['target-file']) ||
		str(process.env.LEARNINGS_STORE) ||
		str(args.file) ||
		DEFAULT_STORE
	);
}
const splitList = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function cmdRecall(args) {
	const file = resolveStore(args);
	const reqPaths = splitList(args.paths);
	// Unbounded by default: issue/planning recall wants every learning that could
	// apply (high recall, tolerate some noise), not a sharp small page. Pass a
	// positive --max-bytes to opt into byte-bounded pagination instead.
	const maxBytes = args['max-bytes'] != null ? Number(args['max-bytes']) : 0;
	const page = args.page != null ? Number(args.page) : 1;
	const format = args.format === 'json' ? 'json' : 'text';

	// Missing store ⇒ no learnings yet; emit nothing, exit 0 (callers tolerate empty).
	const all = existsSync(file) ? parseEntries(readFileSync(file, 'utf8')) : [];
	let matched = all
		.filter((e) => (e.status || 'active') === 'active')
		.filter((e) => matchEntry(e, { paths: reqPaths }));
	matched = rankEntries(matched, { paths: reqPaths });

	// One byte-bounded page of whole entries (never a split/truncated learning),
	// ranked most-relevant first. Pages are disjoint, so an agent that wants more
	// pages forward (--page 2, 3 …) without re-reading learnings it already saw.
	const { entries: shown, page: cur, pages, total } = paginateByBytes(matched, maxBytes, page, { paths: reqPaths });

	if (format === 'json') {
		process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
	} else {
		const text = renderText(shown, { paths: reqPaths });
		if (text) process.stdout.write(text + '\n');
	}

	// More than one page ⇒ tell the driver on stderr (stdout stays pure
	// bullets/JSON for the consuming prompt). Earlier = more relevant, so page 1
	// is the sharpest slice; later pages are the lower-ranked tail, fetched only
	// on demand to keep them out of context until wanted.
	if (pages > 1) {
		const more = cur < pages ? ` Re-run with --page ${cur + 1} for the next page (no repeats).` : ' (last page).';
		process.stderr.write(
			`note: page ${cur}/${pages}, showing ${shown.length} of ${total} matched learning(s), ` +
			`most relevant first.${more}\n`
		);
	}
	// Exit 0 even when empty — callers must tolerate no output.
}

function cmdLearn(args) {
	if (!str(args.text)) fail('learn: --text is required');
	// Store resolution (see resolveStore): --target-file, then $LEARNINGS_STORE,
	// then --file. Both overrides exist so a relative-path write can't strand in
	// the wrong checkout (e.g. /next trunk mode redirects to the worktree store).
	const file = resolveStore(args);

	const entry = buildEntry({
		text: args.text,
		paths: splitList(args.paths),
		issue: str(args.issue),
		pr: str(args.pr),
		date: str(args.date)
	});

	const existing = existsSync(file) ? parseEntries(readFileSync(file, 'utf8')) : [];
	if (!args['allow-dup'] && isDuplicate(entry.text, existing)) {
		process.stdout.write(`duplicate ${entry.id}\n`);
		return;
	}
	mkdirSync(dirname(file) || '.', { recursive: true });
	appendFileSync(file, JSON.stringify(entry) + '\n');
	process.stdout.write(`added ${entry.id}\n`);
}

function cmdForget(args) {
	// Same store resolution as learn (see resolveStore).
	const file = resolveStore(args);
	// Identify the entry by its stable id, given directly or re-derived from the
	// exact text (entryId is the same hash learn used to mint it).
	const id = str(args.id) || (str(args.text) ? entryId(args.text) : undefined);
	if (!id) fail('forget: --id or --text is required');
	const purge = Boolean(args.purge);

	// Missing store ⇒ nothing to forget. Print and exit 0 (a no-op, like learn's
	// duplicate) rather than erroring — callers tolerate "not found".
	if (!existsSync(file)) {
		process.stdout.write(`not found ${id}\n`);
		return;
	}

	const { text, result } = forgetEntry(readFileSync(file, 'utf8'), { id, purge });
	if (result === 'not-found') {
		process.stdout.write(`not found ${id}\n`);
		return;
	}
	if (result === 'already') {
		process.stdout.write(`already forgotten ${id}\n`);
		return;
	}
	writeFileSync(file, text);
	process.stdout.write(`${result === 'purged' ? 'purged' : 'forgot'} ${id}\n`);
}

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	switch (cmd) {
		case 'recall':
			return cmdRecall(args);
		case 'learn':
			return cmdLearn(args);
		case 'forget':
			return cmdForget(args);
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			process.stdout.write(HELP);
			return;
		default:
			fail(`unknown command: ${cmd}\n\n${HELP}`);
	}
}

main();
