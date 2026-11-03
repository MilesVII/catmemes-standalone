/**
 * The Telegram side of the importer scripts: signs in with the session from
 * .env and exposes the channel as a `Source` (see tg-import.ts).
 *
 * Telegram invalidates a session that is used by two connections at once
 * (AUTH_KEY_DUPLICATED), which would mean signing in again. So only one script
 * holds the session at a time: a lock file next to the database names the
 * process that has it, and a second script refuses to start while that
 * process is alive.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { Api, Logger, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../src/server/config.ts";
import type { Message, Source } from "./tg-import.ts";

/** "x" is the 800px rendition the archive has always used; the others are fallbacks for small photos. */
const SIZE_PRIORITY = ["x", "m", "y", "w"];
/** Ids per messages.getMessages request. */
const IDS_PER_REQUEST = 100;

const LOCK_PATH = `${config.dbPath}.tg-lock`;

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
	}
}

/** Takes the session lock; false if another live process holds it. A stale lock is taken over. */
function lock(): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(LOCK_PATH, "wx");
			writeSync(fd, `${process.pid}`);
			closeSync(fd);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const holder = Number.parseInt(readFileSync(LOCK_PATH, "utf8"), 10);
			if (holder && alive(holder)) return false;
			rmSync(LOCK_PATH, { force: true });
		}
	}
	return false;
}

function toMessage(m: Api.Message): Message<Api.Photo> {
	const photo = m.media instanceof Api.MessageMediaPhoto && m.media.photo instanceof Api.Photo ? m.media.photo : null;
	return { id: m.id, date: m.date, text: m.message ?? "", groupedId: m.groupedId?.toString() ?? null, photo };
}

/**
 * Connects and signs in, or exits with code 2 and a reason. `close` must be
 * called when done; it also releases the session lock.
 */
export async function openTelegram(): Promise<{ source: Source<Api.Photo>, close: () => Promise<void> }> {
	const { apiId, apiHash, session } = config.telegram;
	if (!apiId || !apiHash || !session) {
		console.error("TG_API_ID, TG_API_HASH and TG_SESSION must be set; `npm run tg-login` prints a session");
		process.exit(2);
	}
	if (!lock()) {
		console.error(`another script is using the Telegram session (process ${readFileSync(LOCK_PATH, "utf8")}, see ${LOCK_PATH}); try again when it is done`);
		process.exit(2);
	}
	const unlock = () => rmSync(LOCK_PATH, { force: true });

	const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
		connectionRetries: 5,
		// Short flood waits are slept through instead of thrown.
		floodSleepThreshold: 120,
		baseLogger: new Logger(LogLevel.WARN)
	});
	const close = async () => {
		await client.disconnect();
		unlock();
	};
	try {
		await client.connect();
		if (!await client.checkAuthorization()) {
			console.error("the session is not signed in; run `npm run tg-login` and put the new TG_SESSION into .env");
			await close();
			process.exit(2);
		}
	} catch (e) {
		unlock();
		throw e;
	}

	const channel = config.channel;
	const byIds = async (ids: number[]) => {
		const found = new Map<number, Message<Api.Photo>>();
		for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
			const chunk = ids.slice(i, i + IDS_PER_REQUEST);
			// Deleted messages come back as empty ones (or not at all); both read as gone.
			for (const m of await client.getMessages(channel, { ids: chunk }))
				if (m instanceof Api.Message) found.set(m.id, toMessage(m));
		}
		return ids.map(id => found.get(id) ?? null);
	};
	const source: Source<Api.Photo> = {
		after: async (after, limit) =>
			(await client.getMessages(channel, { minId: after, limit, reverse: true, waitTime: 1200 })).map(toMessage),
		byIds,
		byId: async id => (await byIds([id]))[0],
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
	return { source, close };
}
