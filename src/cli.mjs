#!/usr/bin/env node
// learnings CLI — the thin shell over learnings-core.mjs. Three commands:
//   recall  — read all *.ndjson in --dir, filter/rank/bound, emit bullets|json
//   learn   — append one deduped entry to learnings.ndjson at the target path
//   migrate — one-time, best-effort: legacy <area>.md → NDJSON
//
// Project-agnostic: every command takes --dir <learnings-dir>. All logic lives
// in learnings-core; this file only does argv parsing and file I/O.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import {
	parseEntries,
	matchEntry,
	rankEntries,
	boundByBytes,
	renderText,
	buildEntry,
	isDuplicate,
	mdBulletsToEntries,
	parseBlameCommit,
	commitFilesToCandidates
} from './learnings-core.mjs';

const HELP = `learnings — shared recall/learn over a path-scoped NDJSON learnings store

Usage:
  learnings recall  --dir <d> [--paths a,b]
                    [--max-bytes 4000] [--format text|json]
  learnings learn   --dir <d> --text "..." [--paths a/**,b.ts]
                    [--issue N] [--pr N] [--date YYYY-MM-DD]
                    [--target-dir <abs>] [--allow-dup]
  learnings migrate --md <file.md> [--out <f>]
                    [--blame]   # fill candidate paths from each bullet's git history

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

// The single store file. recall still scans every *.ndjson in --dir (so legacy
// per-area files keep working), but writes always land here.
const STORE_FILE = 'learnings.ndjson';

const str = (v) => (typeof v === 'string' && v ? v : undefined);
const splitList = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function listNdjson(dir) {
	if (!dir || !existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith('.ndjson'))
		.sort()
		.map((f) => join(dir, f));
}

function cmdRecall(args) {
	const dir = str(args.dir);
	if (!dir) fail('recall: --dir <learnings-dir> is required');
	const reqPaths = splitList(args.paths);
	const maxBytes = args['max-bytes'] != null ? Number(args['max-bytes']) : 4000;
	const format = args.format === 'json' ? 'json' : 'text';

	let all = [];
	for (const f of listNdjson(dir)) {
		all = all.concat(parseEntries(readFileSync(f, 'utf8')));
	}
	let matched = all
		.filter((e) => (e.status || 'active') === 'active')
		.filter((e) => matchEntry(e, { paths: reqPaths }));
	matched = rankEntries(matched, { paths: reqPaths });
	matched = boundByBytes(matched, maxBytes);

	if (format === 'json') {
		process.stdout.write(JSON.stringify(matched, null, 2) + '\n');
	} else {
		const text = renderText(matched);
		if (text) process.stdout.write(text + '\n');
	}
	// Exit 0 even when empty — callers must tolerate no output.
}

function cmdLearn(args) {
	if (!str(args.text)) fail('learn: --text is required');
	// The --target-dir worktree rule: always write to the explicit target path,
	// overriding --dir, so a relative-path write can't strand in the wrong checkout.
	const targetDir = str(args['target-dir']) || str(args.dir);
	if (!targetDir) fail('learn: --dir or --target-dir is required');

	const entry = buildEntry({
		text: args.text,
		paths: splitList(args.paths),
		issue: str(args.issue),
		pr: str(args.pr),
		date: str(args.date)
	});

	const file = join(targetDir, STORE_FILE);
	const existing = existsSync(file) ? parseEntries(readFileSync(file, 'utf8')) : [];
	if (!args['allow-dup'] && isDuplicate(entry.text, existing)) {
		process.stdout.write(`duplicate ${entry.id}\n`);
		return;
	}
	mkdirSync(targetDir, { recursive: true });
	appendFileSync(file, JSON.stringify(entry) + '\n');
	process.stdout.write(`added ${entry.id}\n`);
}

function cmdMigrate(args) {
	const mdPath = str(args.md);
	if (!mdPath) fail('migrate: --md <file.md> is required');
	if (!existsSync(mdPath)) fail(`migrate: file not found: ${mdPath}`);

	// Default output is named after the .md so migrating several files into one
	// dir doesn't silently overwrite; combine into learnings.ndjson downstream.
	const out = str(args.out) || join(dirname(mdPath), `${basename(mdPath, '.md')}.ndjson`);
	const { entries, flagged } = mdBulletsToEntries(readFileSync(mdPath, 'utf8'));

	// --blame: for each low-confidence row, blame its source line to find the
	// commit that introduced the bullet, then take that commit's changed files as
	// candidate paths. These are *candidates* — an agent/human still tightens them
	// to precise globs (see CONTRACT/README). Best-effort: a bullet whose blame
	// yields only docs (or whose .md isn't under git) stays flagged.
	if (args.blame) {
		const byId = new Map(entries.map((e) => [e.id, e]));
		const repoDir = dirname(mdPath) || '.';
		const mdName = basename(mdPath);
		for (const f of flagged) {
			if (!f.line) continue;
			const blame = git(repoDir, ['blame', '-L', `${f.line},${f.line}`, '--porcelain', '--', mdName]);
			const sha = blame.status === 0 ? parseBlameCommit(blame.stdout) : null;
			if (!sha) continue;
			const show = git(repoDir, ['show', '--name-only', '--pretty=format:', sha]);
			if (show.status !== 0) continue;
			const cands = commitFilesToCandidates(show.stdout, { exclude: ['docs/learnings/**', mdName, '*.md'] });
			const e = byId.get(f.id);
			if (e && cands.length) {
				e.paths = cands;
				f.candidates = cands;
			}
		}
	}

	const body = entries.map((e) => JSON.stringify(e)).join('\n');
	writeFileSync(out, body ? body + '\n' : '');
	process.stdout.write(`migrated ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} -> ${out}\n`);
	if (flagged.length) {
		const verb = args.blame ? 'need an agent/human pass to tighten the candidate paths' : 'need a human pass (no inline path)';
		process.stderr.write(`\n${flagged.length} low-confidence row(s) ${verb}:\n`);
		for (const f of flagged) {
			const where = f.candidates ? ` → candidates: ${f.candidates.join(', ')}` : '';
			process.stderr.write(`  - [${f.id}] ${truncate(f.text, 80)}${where}\n`);
		}
	}
}

// Run git in `cwd`; returns { status, stdout, stderr }. Used only by migrate --blame.
function git(cwd, args) {
	const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	return { status: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	switch (cmd) {
		case 'recall':
			return cmdRecall(args);
		case 'learn':
			return cmdLearn(args);
		case 'migrate':
			return cmdMigrate(args);
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
