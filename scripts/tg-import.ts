/**
 * Imports channel posts into the database and the media directory. The
 * Telegram side is abstracted as a `Source`, so the logic also runs against a
 * fake one in tests.
 *
 * What keeps the import exact when Telegram hiccups:
 * - posts are handled in id order and the run stops at the first post whose
 *   media cannot be fetched after retries, so nothing after it is skipped;
 * - a post row is written only once every one of its media files is on disk;
 * - the cursor (highest message id fully handled) lives in the meta table and
 *   moves only past posts that were stored or had nothing to store;
 * - an album is imported once it is settled: its messages are older than
 *   `settleSeconds` and it does not touch the end of a full batch, where the
 *   rest of it may still be beyond the window.
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { getMeta, setMeta, type Database } from "../src/server/db.ts";
import { recalculateCoverage, storePost } from "../src/server/api.ts";

export type Message<P> = {
	id: number,
	/** unix seconds */
	date: number,
	text: string,
	/** album id; messages sharing it form one post */
	groupedId: string | null,
	/** handle given back to `download`; null for messages without a photo */
	photo: P | null
};

export type Source<P> = {
	/** Up to `limit` messages with ids above `after`, oldest first. */
	after(after: number, limit: number): Promise<Message<P>[]>,
	/** One message by id, or null if it is gone. */
	byId(id: number): Promise<Message<P> | null>,
	download(photo: P): Promise<Uint8Array>
};

export type ImportOptions = {
	/** messages per request */
	stride: number,
	/** a post at the head of the channel is imported only once this old */
	settleSeconds: number,
	/** waits between download attempts; one attempt more than entries */
	retryDelaysMs: number[],
	timeoutMs: number,
	now: () => number,
	log: (line: string) => void
};

export type ImportReport = {
	imported: number,
	/** id of the post whose media could not be fetched; the run stopped there */
	failed: number | null
};

/** A post assembled from one message or one album. */
export type Draft<P> = {
	/** first message id, which is the post id */
	id: number,
	/** last message id, where the cursor goes once the post is handled */
	lastId: number,
	date: number,
	text: string,
	photos: P[]
};

const CURSOR_KEY = "tg-cursor";
/** Telegram albums hold at most this many messages. */
const ALBUM_MAX = 10;

const DEFAULTS: ImportOptions = {
	stride: 100,
	settleSeconds: 120,
	retryDelaysMs: [3000, 10000, 30000],
	timeoutMs: 60000,
	now: Date.now,
	log: console.log
};

/** Folds messages into posts, oldest first: an album becomes one post under its first message's id. */
export function groupPosts<P>(messages: Message<P>[]): Draft<P>[] {
	const byAlbum = new Map<string, Draft<P>>();
	const drafts: Draft<P>[] = [];
	for (const m of [...messages].sort((a, b) => a.id - b.id)) {
		let draft = m.groupedId === null ? undefined : byAlbum.get(m.groupedId);
		if (!draft) {
			draft = { id: m.id, lastId: m.id, date: m.date, text: "", photos: [] };
			drafts.push(draft);
			if (m.groupedId !== null) byAlbum.set(m.groupedId, draft);
		}
		draft.lastId = Math.max(draft.lastId, m.id);
		draft.date = Math.max(draft.date, m.date);
		if (m.text && !draft.text) draft.text = m.text; // an album's caption sits on one of its messages
		if (m.photo !== null) draft.photos.push(m.photo);
	}
	return drafts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
		promise.then(
			value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); }
		);
	});
}

/** Downloads one photo, retrying with the configured delays; null once they are used up. */
async function fetchPhoto<P>(source: Source<P>, photo: P, label: string, opts: ImportOptions): Promise<Uint8Array | null> {
	for (let attempt = 0; ; attempt++) {
		try {
			const bytes = await withTimeout(source.download(photo), opts.timeoutMs);
			if (bytes.length === 0) throw new Error("empty download");
			return bytes;
		} catch (e) {
			const reason = (e as Error)?.message ?? String(e);
			if (attempt >= opts.retryDelaysMs.length) {
				opts.log(`${label}: giving up after ${attempt + 1} attempts (${reason})`);
				return null;
			}
			const delay = opts.retryDelaysMs[attempt];
			opts.log(`${label}: attempt ${attempt + 1} failed (${reason}), retrying in ${delay / 1000}s`);
			await sleep(delay);
		}
	}
}

/** Fetches the post's media, writes it, then the row. False if any download failed; nothing is written then. */
async function importPost<P>(db: Kysely<Database>, source: Source<P>, mediaDir: string, draft: Draft<P>, opts: ImportOptions) {
	const pending: { key: string, bytes: Uint8Array }[] = [];
	for (let i = 0; i < draft.photos.length; i++) {
		const key = `tg${draft.id}-${i}`;
		// Left behind by an earlier run that stopped before writing the row.
		if (existsSync(path.join(mediaDir, key)) && statSync(path.join(mediaDir, key)).size > 0) continue;
		const bytes = await fetchPhoto(source, draft.photos[i], key, opts);
		if (bytes === null) return false;
		pending.push({ key, bytes });
	}
	for (const { key, bytes } of pending) {
		const part = path.join(mediaDir, `.${key}.part`);
		writeFileSync(part, bytes);
		renameSync(part, path.join(mediaDir, key));
	}
	await storePost(db, { id: draft.id, caption: draft.text, time: draft.date, mediaCount: draft.photos.length });
	return true;
}

/**
 * The stored cursor, or on first use the newest post in the database. If that
 * post is an album, the cursor is moved past the album's other messages so
 * they are not imported again as a second post.
 */
async function initialCursor<P>(db: Kysely<Database>, source: Source<P>, log: ImportOptions["log"]) {
	const stored = await getMeta(db, CURSOR_KEY);
	if (stored !== null) return Number(stored);

	const row = await db
		.selectFrom("posts")
		.select(sql<number | null>`MAX(CAST(SUBSTR(id, 3) AS INTEGER))`.as("max"))
		.where("id", "like", "tg%")
		.executeTakeFirst();
	let cursor = row?.max ?? 0;
	if (cursor > 0) {
		const head = await source.byId(cursor);
		if (head?.groupedId) {
			for (const m of await source.after(cursor, ALBUM_MAX))
				if (m.groupedId === head.groupedId) cursor = m.id;
				else break;
		}
	}
	log(`no stored cursor; starting after message ${cursor}`);
	return cursor;
}

/** Imports everything new. Recomputes the tag coverage snapshot when posts were added. */
export async function importPosts<P>(db: Kysely<Database>, source: Source<P>, mediaDir: string, options: Partial<ImportOptions> = {}): Promise<ImportReport> {
	const opts = { ...DEFAULTS, ...options };
	mkdirSync(mediaDir, { recursive: true });
	let cursor = await initialCursor(db, source, opts.log);
	let imported = 0;
	let failed: number | null = null;

	batches: while (true) {
		const batch = await source.after(cursor, opts.stride);
		if (batch.length === 0) break;
		const atHead = batch.length < opts.stride;
		const drafts = groupPosts(batch);
		// The last post may continue beyond a full batch, or still be receiving album messages.
		const last = drafts[drafts.length - 1];
		if (!atHead || last.date * 1000 > opts.now() - opts.settleSeconds * 1000) drafts.pop();

		for (const draft of drafts) {
			if (draft.photos.length > 0) {
				if (!await importPost(db, source, mediaDir, draft, opts)) {
					failed = draft.id;
					break batches;
				}
				imported++;
				opts.log(`post ${draft.id}: ${draft.photos.length} photo(s)`);
			}
			cursor = draft.lastId;
			await setMeta(db, CURSOR_KEY, `${cursor}`);
		}
		if (atHead || drafts.length === 0) break;
	}

	if (imported > 0) await recalculateCoverage(db);
	return { imported, failed };
}
