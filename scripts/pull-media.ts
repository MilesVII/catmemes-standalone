/**
 * Copies every post's media from a running instance (the Cloudflare worker or
 * another standalone server) into MEDIA_DIR. Posts come from the local database,
 * so run `db:import` first. Already-downloaded files are skipped, so it is safe
 * to re-run after an interruption.
 *
 *   npm run media:pull -- https://catmemes.example.workers.dev [--concurrency 8]
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/server/config.ts";
import { connect } from "../src/server/db.ts";

const args = process.argv.slice(2);
const origin = args.find(a => /^https?:\/\//.test(a))?.replace(/\/+$/, "");
const concurrencyFlag = args.indexOf("--concurrency");
const concurrency = concurrencyFlag >= 0 ? Number.parseInt(args[concurrencyFlag + 1] ?? "8", 10) : 8;

if (!origin) {
	console.error("usage: pull-media.ts <https://origin> [--concurrency N]");
	process.exit(2);
}

mkdirSync(config.mediaDir, { recursive: true });

const db = connect(config.dbPath);
const posts = await db.selectFrom("posts").select(["id", "media"]).execute();
await db.destroy();

const keys = posts.flatMap(p =>
	p.media.length === 0 ? [] : p.media.split("\n").map((_, i) => `${p.id}-${i}`)
);
const pending = keys.filter(key => !existsSync(path.join(config.mediaDir, key)));
console.log(`${keys.length} media keys in db, ${pending.length} to download from ${origin}`);

let done = 0, missing = 0, failed = 0;
async function worker() {
	while (pending.length > 0) {
		const key = pending.shift()!;
		try {
			const response = await fetch(`${origin}/r2/${key}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			// The worker answers 200 with an empty body for keys R2 does not have.
			if (!response.ok || bytes.length === 0) { missing++; continue; }
			await writeFile(path.join(config.mediaDir, key), bytes);
			done++;
		} catch (e) {
			failed++;
			console.error(`${key}: ${(e as Error).message}`);
		}
		const total = done + missing + failed;
		if (total % 200 === 0) console.log(`${total} processed (${done} saved, ${missing} missing, ${failed} failed)`);
	}
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`finished: ${done} saved, ${missing} missing upstream, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
