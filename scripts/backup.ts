/**
 * Archives the database and media into one .tar.gz. Safe to run while the
 * server is up: the database is copied with VACUUM INTO, which yields a
 * consistent snapshot including anything still in the WAL.
 *
 *   npm run backup                          # ./backups/catmemes-<timestamp>.tar.gz
 *   npm run backup -- /var/backups/catmemes/  # into that directory
 *   npm run backup -- ~/gatos.tar.gz          # exact file name
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { config } from "../src/server/config.ts";
import { pack, type PackEntry } from "./tar.ts";
import { ARCHIVE_DB, ARCHIVE_MANIFEST, ARCHIVE_MEDIA, sqlString, stamp } from "./archive.ts";

function outputPath(arg: string | undefined) {
	const name = `catmemes-${stamp()}.tar.gz`;
	if (!arg) return path.resolve("backups", name);
	const isDir = arg.endsWith("/") || arg.endsWith("\\") || (existsSync(arg) && statSync(arg).isDirectory());
	return path.resolve(isDir ? path.join(arg, name) : arg);
}

if (!existsSync(config.dbPath)) {
	console.error(`no database at ${config.dbPath}`);
	process.exit(1);
}

const started = Date.now();
const out = outputPath(process.argv[2]);
mkdirSync(path.dirname(out), { recursive: true });
const partial = `${out}.partial`;
const snapshot = `${out}.snapshot.db`;
rmSync(snapshot, { force: true });

const live = new DatabaseSync(config.dbPath);
live.exec("PRAGMA busy_timeout = 5000");
live.exec(`VACUUM INTO ${sqlString(snapshot)}`);
live.close();

const snap = new DatabaseSync(snapshot, { readOnly: true });
const countOf = (table: string) => (snap.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
const tables = new Set(snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => (r as { name: string }).name));
const counts = Object.fromEntries(
	["posts", "tags", "pairs", "suggestions"].filter(t => tables.has(t)).map(t => [t, countOf(t)])
);
snap.close();

const media = existsSync(config.mediaDir)
	? readdirSync(config.mediaDir, { withFileTypes: true })
		.filter(e => e.isFile() && !e.name.startsWith("."))
		.map(e => e.name)
		.sort()
	: [];

const manifest = Buffer.from(JSON.stringify({
	format: 1,
	created: new Date().toISOString(),
	counts,
	mediaFiles: media.length
}, null, "\t"));

let mediaBytes = 0;
let done = 0;
function* entries(): Generator<PackEntry> {
	yield { name: ARCHIVE_MANIFEST, size: manifest.length, mtime: Date.now(), content: () => [manifest] };

	const dbInfo = statSync(snapshot);
	yield { name: ARCHIVE_DB, size: dbInfo.size, mtime: dbInfo.mtimeMs, content: () => createReadStream(snapshot) };

	for (const name of media) {
		const file = path.join(config.mediaDir, name);
		let info;
		try { info = statSync(file); } catch { continue; } // deleted meanwhile
		mediaBytes += info.size;
		if (++done % 1000 === 0) console.log(`${done} / ${media.length} media files`);
		yield {
			name: ARCHIVE_MEDIA + name,
			size: info.size,
			mtime: info.mtimeMs,
			content: () => createReadStream(file),
			onShort: missing => console.warn(`${name} shrank by ${missing} bytes while archiving; zero-filled`)
		};
	}
}

try {
	// Media is already compressed; level 1 keeps large archives fast.
	await pipeline(Readable.from(pack(entries())), createGzip({ level: 1 }), createWriteStream(partial));
	renameSync(partial, out);
} catch (e) {
	rmSync(partial, { force: true });
	throw e;
} finally {
	rmSync(snapshot, { force: true });
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`backup written: ${out}`);
console.log(`  ${JSON.stringify(counts)}, ${media.length} media files (${mb(mediaBytes)})`);
console.log(`  archive ${mb(statSync(out).size)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
