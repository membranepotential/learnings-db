#!/usr/bin/env node
// learnings CLI — the thin shell over learnings-core.mjs. Two commands:
//   recall  — read the store file, filter/rank/paginate, emit bullets|json
//   learn   — append one deduped entry to the store file
//
// Project-agnostic: recall/learn take --file <learnings.ndjson> (default
// .learnings.ndjson in the cwd). All logic lives in learnings-core; this file
// only does argv parsing and file I/O.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	parseEntries,
	matchEntry,
	rankEntries,
	paginateByBytes,
	renderText,
	buildEntry,
	isDuplicate
} from './learnings-core.mjs';

const HELP = `learnings — shared recall/learn over a path-scoped NDJSON learnings store

Usage:
  learnings recall  [--file <learnings.ndjson>] [--paths a,b]
                    [--max-bytes N] [--page 1] [--format text|json]
  learnings learn   --text "..." [--file <learnings.ndjson>] [--paths a/**,b.ts]
                    [--issue N] [--pr N] [--date YYYY-MM-DD]
                    [--target-file <abs>] [--allow-dup]

--file defaults to .learnings.ndjson in the current directory.
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
const splitList = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function cmdRecall(args) {
	const file = str(args.file) || DEFAULT_STORE;
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
	// The --target-file worktree rule: always write to the explicit target path,
	// overriding --file, so a relative-path write can't strand in the wrong checkout.
	const file = str(args['target-file']) || str(args.file) || DEFAULT_STORE;

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

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	switch (cmd) {
		case 'recall':
			return cmdRecall(args);
		case 'learn':
			return cmdLearn(args);
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
