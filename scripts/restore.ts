/**
 * Restores a backup made by backup.ts:
 * - the database is replaced (the current one is kept as
 *   <db>.before-restore-<timestamp> first);
 * - media is merged: files from the archive are added or overwritten,
 *   files that exist only on disk are kept.
 *
 * Stop the server first; the script refuses to run while it answers.
 *
 *   npm run restore -- backups/catmemes-20261012-193000.tar.gz [--force]
 */
import { chownSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { config } from "../src/server/config.ts";
import { extract, type EntryHandler } from "./tar.ts";
import { ARCHIVE_DB, ARCHIVE_MANIFEST, ARCHIVE_MEDIA, MEDIA_NAME, sqlString, stamp } from "./archive.ts";

const args = process.argv.slice(2);
const force = args.includes("--force");
const archive = args.find(a => !a.startsWith("--"));

if (!archive || !existsSync(archive)) {
	console.error("usage: npm run restore -- <backup.tar.gz> [--force]");
	process.exit(2);
}

if (!force) {
	const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
	const running = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${config.port}/`, { signal: AbortSignal.timeout(1500) })
		.then(() => true, () => false);
	if (running) {
		console.error(`the server is answering on ${host}:${config.port}; stop it first (sudo systemctl stop catmemes), or pass --force`);
		process.exit(1);
	}
}

mkdirSync(path.dirname(config.dbPath), { recursive: true });
mkdirSync(config.mediaDir, { recursive: true });

// When run as root (plain `sudo npm run restore`), hand new files to whoever owns the data,
// so the service user can still write them.
const owner = process.getuid?.() === 0 ? statSync(path.dirname(config.dbPath)) : null;
const mediaOwner = process.getuid?.() === 0 ? statSync(config.mediaDir) : null;
const chown = (file: string, from: { uid: number, gid: number } | null) => { if (from) chownSync(file, from.uid, from.gid); };

const incomingDb = `${config.dbPath}.restore-tmp`;
rmSync(incomingDb, { force: true });

function validateDb(file: string) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const check = (db.prepare("PRAGMA quick_check").get() as Record<string, string>);
		if (Object.values(check)[0] !== "ok") throw new Error(`database in the archive failed its integrity check: ${JSON.stringify(check)}`);
		const posts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get();
		if (!posts) throw new Error("database in the archive has no posts table");
		return (db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
	} finally {
		db.close();
	}
}

function collect(onData: (data: Buffer) => void): Writable {
	const chunks: Buffer[] = [];
	return new Writable({
		write(chunk, _encoding, callback) { chunks.push(chunk); callback(); },
		final(callback) { onData(Buffer.concat(chunks)); callback(); }
	});
}

let manifest: any = null;
let restoredPosts: number | null = null;
let mediaCount = 0;
const skipped: string[] = [];

try {
	await pipeline(createReadStream(archive), createGunzip(), async function (source) {
		await extract(source, (entry): EntryHandler => {
			if (entry.name === ARCHIVE_MANIFEST)
				return { sink: collect(data => { manifest = JSON.parse(data.toString("utf8")); }) };

			if (entry.name === ARCHIVE_DB)
				return {
					sink: createWriteStream(incomingDb),
					// The database comes before media, so a bad one stops the restore early.
					done: () => { restoredPosts = validateDb(incomingDb); }
				};

			if (entry.name.startsWith(ARCHIVE_MEDIA)) {
				const name = entry.name.slice(ARCHIVE_MEDIA.length);
				if (!MEDIA_NAME.test(name) || name === "." || name === "..") {
					skipped.push(entry.name);
					return null;
				}
				const target = path.join(config.mediaDir, name);
				const temp = path.join(config.mediaDir, `.${name}.restore-tmp`);
				return {
					sink: createWriteStream(temp),
					done: () => {
						renameSync(temp, target);
						chown(target, mediaOwner);
						if (++mediaCount % 1000 === 0) console.log(`${mediaCount} media files restored`);
					}
				};
			}

			skipped.push(entry.name);
			return null;
		});
	});
} catch (e) {
	rmSync(incomingDb, { force: true });
	console.error(`restore aborted: ${(e as Error).message}`);
	if (mediaCount > 0) console.error(`${mediaCount} media files were already merged; the database was not touched`);
	process.exit(1);
}

if (restoredPosts === null) {
	console.error(`the archive contains no ${ARCHIVE_DB}; ${mediaCount} media files were merged, the database was not touched`);
	process.exit(1);
}

let safetyCopy: string | null = null;
if (existsSync(config.dbPath)) {
	safetyCopy = `${config.dbPath}.before-restore-${stamp()}`;
	const current = new DatabaseSync(config.dbPath);
	current.exec(`VACUUM INTO ${sqlString(safetyCopy)}`);
	current.close();
	chown(safetyCopy, owner);
}
for (const suffix of ["-wal", "-shm", ""]) rmSync(config.dbPath + suffix, { force: true });
renameSync(incomingDb, config.dbPath);
chown(config.dbPath, owner);

if (manifest) console.log(`backup from ${manifest.created}: ${JSON.stringify(manifest.counts)}, ${manifest.mediaFiles} media files`);
console.log(`database replaced (${restoredPosts} posts): ${config.dbPath}`);
if (safetyCopy) console.log(`previous database kept as ${safetyCopy}`);
console.log(`media merged into ${config.mediaDir}: ${mediaCount} files written`);
if (skipped.length > 0) console.warn(`ignored ${skipped.length} unexpected entries, e.g. ${skipped.slice(0, 3).join(", ")}`);
