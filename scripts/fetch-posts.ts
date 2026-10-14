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
import { Api, Logger, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../src/server/config.ts";
import { connect, ensureSchema } from "../src/server/db.ts";
import { importPosts, type Message, type Source } from "./tg-import.ts";

const { apiId, apiHash, session } = config.telegram;
if (!apiId || !apiHash || !session) {
	console.error("TG_API_ID, TG_API_HASH and TG_SESSION must be set; `npm run tg-login` prints a session");
	process.exit(2);
}

/** "x" is the 800px rendition the archive has always used; the others are fallbacks for small photos. */
const SIZE_PRIORITY = ["x", "m", "y", "w"];

function toMessage(m: Api.Message): Message<Api.Photo> {
	const photo = m.media instanceof Api.MessageMediaPhoto && m.media.photo instanceof Api.Photo ? m.media.photo : null;
	return { id: m.id, date: m.date, text: m.message ?? "", groupedId: m.groupedId?.toString() ?? null, photo };
}

const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
	connectionRetries: 5,
	// Short flood waits are slept through instead of thrown.
	floodSleepThreshold: 120,
	baseLogger: new Logger(LogLevel.WARN)
});
await client.connect();
if (!await client.checkAuthorization()) {
	console.error("the session is not signed in; run `npm run tg-login` and put the new TG_SESSION into .env");
	await client.disconnect();
	process.exit(2);
}

const channel = config.channel;
const source: Source<Api.Photo> = {
	after: async (after, limit) =>
		(await client.getMessages(channel, { minId: after, limit, reverse: true, waitTime: 1200 })).map(toMessage),
	byId: async id => {
		const [m] = await client.getMessages(channel, { ids: [id] });
		return m ? toMessage(m) : null;
	},
	download: async photo => {
		const types = new Set(photo.sizes.map(s => s.type));
		const size = SIZE_PRIORITY.find(t => types.has(t));
		if (!size) throw new Error(`no usable size among ${[...types].join(", ")}`);
		const bytes = await client.downloadFile(
			new Api.InputPhotoFileLocation({
				id: photo.id,
				accessHash: photo.accessHash,
				fileReference: photo.fileReference,
				thumbSize: size
			}),
			{ dcId: photo.dcId }
		);
		if (!(bytes instanceof Uint8Array)) throw new Error("download returned no data");
		return bytes;
	}
};

const db = connect(config.dbPath);
try {
	await ensureSchema(db);
	const report = await importPosts(db, source, config.mediaDir);
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
	await client.disconnect();
	process.exit(); // gramjs keeps timers alive after disconnecting
}
