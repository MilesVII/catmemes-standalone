/**
 * Pulls new posts from the Telegram channel straight into the database and
 * media directory. Meant for a timer (deploy/catmemes-fetch.timer), run as the
 * service user:
 *
 *   npm run fetch
 *
 * Needs TG_API_ID, TG_API_HASH and TG_SESSION (see scripts/tg-login.ts) and
 * TG_CHANNEL. Exits 1 when a post's media could not be fetched; the next run
 * picks up from that post.
 */
import { config } from "../src/server/config.ts";
import { connect, ensureSchema } from "../src/server/db.ts";
import { openTelegram } from "./tg-client.ts";
import { importPosts } from "./tg-import.ts";

const telegram = await openTelegram();
const db = connect(config.dbPath);
try {
	await ensureSchema(db);
	const report = await importPosts(db, telegram.source, config.mediaDir);
	if (report.failed === null) {
		console.log(`done: ${report.imported} new post(s)`);
	} else {
		console.error(`stopped at post ${report.failed} after ${report.imported} new post(s); the next run retries it`);
		process.exitCode = 1;
	}
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	await db.destroy();
	await telegram.close();
	process.exit(); // gramjs keeps timers alive after disconnecting
}
