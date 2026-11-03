/**
 * Downloads the pictures of already stored channel posts again, for files
 * that are missing, empty or cut short (a JPEG without its end marker, left
 * by an interrupted download). Uses the importer's Telegram credentials; run
 * it as the service user so the files belong to it:
 *
 *   sudo -u catmemes npm run refetch-media                    # every post with a broken picture
 *   sudo -u catmemes npm run refetch-media -- --dry-run       # only list them, no Telegram
 *   sudo -u catmemes npm run refetch-media -- tg2432 5120     # just these posts
 *
 * Named posts are checked against the channel even when their files look
 * fine, so an album that lists fewer pictures than the channel has gets the
 * rest added. Safe to run again: only what is still broken is fetched. Exits
 * 1 when some download failed after retries.
 */
import { config } from "../src/server/config.ts";
import { connect, ensureSchema } from "../src/server/db.ts";
import { findMediaGaps, refetchMedia, type MediaGap } from "./tg-import.ts";

const postId = (arg: string) => Number(arg.replace(/^tg/, ""));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const named = args.filter(a => !a.startsWith("--"));
const only = named.map(postId);
const bad = args.find(a => a.startsWith("--") ? a !== "--dry-run" : !(Number.isSafeInteger(postId(a)) && postId(a) > 0));
if (bad !== undefined) {
	console.error(`usage: refetch-media [--dry-run] [tg<id> ...]; not understood: ${bad}`);
	process.exit(2);
}

const describe = (gap: MediaGap) => {
	if (gap.broken.length === 0) return `tg${gap.id}: ${gap.count} picture(s), files fine`;
	const problems = new Map<string, number[]>();
	for (const b of gap.broken) problems.set(b.problem, [...problems.get(b.problem) ?? [], b.index]);
	return `tg${gap.id}: ${[...problems].map(([problem, indexes]) => `${problem} ${indexes.join(",")}`).join("; ")} of ${gap.count}`;
};

const db = connect(config.dbPath);
let close = async () => {};
try {
	await ensureSchema(db);
	const gaps = await findMediaGaps(db, config.mediaDir, named.length > 0 ? only : null);
	const missingPosts = only.filter(id => !gaps.some(g => g.id === id));
	for (const id of missingPosts) console.log(`tg${id}: no such post in the database`);

	const files = gaps.reduce((n, g) => n + g.broken.length, 0);
	if (dryRun || gaps.length === 0) {
		for (const gap of gaps) console.log(describe(gap));
		console.log(`${files} broken file(s) in ${gaps.filter(g => g.broken.length > 0).length} post(s)${dryRun ? "; nothing fetched (dry run)" : ""}`);
	} else {
		console.log(`${files} broken file(s) in ${gaps.filter(g => g.broken.length > 0).length} post(s); fetching from the channel`);
		// Loaded only now, so a dry run works without Telegram credentials.
		const { openTelegram } = await import("./tg-client.ts");
		const telegram = await openTelegram();
		close = telegram.close;
		const report = await refetchMedia(db, telegram.source, config.mediaDir, gaps);
		const list = (ids: number[]) => ids.map(id => `tg${id}`).join(" ");
		console.log(`done: ${report.written} file(s) written`);
		if (report.extended.length) console.log(`pictures added to: ${list(report.extended)}`);
		if (report.gone.length) console.log(`gone from the channel, left as they are: ${list(report.gone)}`);
		if (report.mismatched.length) console.log(`the channel has fewer pictures than listed, left alone: ${list(report.mismatched)}`);
		if (report.failed.length) {
			console.error(`downloads failed, run again to retry: ${list(report.failed)}`);
			process.exitCode = 1;
		}
	}
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	await db.destroy();
	await close();
	process.exit(); // gramjs keeps timers alive after disconnecting
}
