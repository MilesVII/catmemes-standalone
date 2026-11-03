/**
 * Text transcriptions of channel pictures, supplied by the transcriber bot.
 *
 * One row per Telegram message, i.e. per picture: an album is one post here
 * but several messages there. `post` is filled in when the post is known; a
 * transcript may arrive before the importer has fetched its post, and is
 * linked when the post is stored (`linkTranscripts`).
 *
 * The search index (`transcripts_fts`, rowid = message) holds stemmed terms
 * of the text and the keywords; see search.ts.
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "./db.ts";
import { ftsQuery, terms, type Vocabulary } from "./search.ts";

export const TRANSCRIPT_LIMITS = { text: 8000, keywords: 300, keyword: 200 };
/** Telegram albums hold at most ten pictures, so a message is at most nine ids past its post. */
const ALBUM_MAX = 10;

export type TranscriptInput = {
	/** message id in the channel */
	message: number,
	text: string,
	keywords: string[]
};

/** The post a message belongs to: the post with its id, or an album starting shortly before it that spans it. */
export async function postFor(db: Kysely<Database>, message: number): Promise<string | null> {
	const ids = Array.from({ length: ALBUM_MAX }, (_, d) => `tg${message - d}`);
	const rows = await db.selectFrom("posts").select(["id", "media"]).where("id", "in", ids).execute();
	const byId = new Map(rows.map(r => [r.id, r.media.split("\n").length]));
	for (let d = 0; d < ALBUM_MAX; d++) {
		const mediaCount = byId.get(ids[d]);
		// The nearest earlier post decides: a farther one cannot reach past it.
		if (mediaCount !== undefined) return d < mediaCount ? ids[d] : null;
	}
	return null;
}

/** Adds or replaces the transcript of one message. */
export async function putTranscript(db: Kysely<Database>, input: TranscriptInput) {
	return await db.transaction().execute(trx => writeTranscript(trx, input));
}

/** The write itself; the caller provides the transaction (the import script batches many). */
export async function writeTranscript(trx: Kysely<Database>, input: TranscriptInput) {
	const keywords = [...new Set(input.keywords.map(k => k.trim()).filter(k => k.length > 0))];
	const indexed = terms(`${input.text} ${keywords.join(" ")}`).join(" ");
	const post = await postFor(trx, input.message);
	const values = { post, text: input.text, keywords: JSON.stringify(keywords), updated: Date.now() };
	const existed = await trx.selectFrom("transcripts").select("message").where("message", "=", input.message).executeTakeFirst();
	await trx
		.insertInto("transcripts")
		.values({ message: input.message, ...values })
		.onConflict(oc => oc.column("message").doUpdateSet(values))
		.execute();
	await sql`DELETE FROM transcripts_fts WHERE rowid = ${input.message}`.execute(trx);
	await sql`INSERT INTO transcripts_fts (rowid, terms) VALUES (${input.message}, ${indexed})`.execute(trx);
	return { post, replaced: existed !== undefined };
}

/** Attaches waiting transcripts to a post that was just stored; `first`..`last` are its message ids. */
export async function linkTranscripts(db: Kysely<Database>, first: number, last: number) {
	await db
		.updateTable("transcripts")
		.set({ post: `tg${first}` })
		.where("post", "is", null)
		.where("message", ">=", first)
		.where("message", "<=", last)
		.execute();
}

let cached: { key: string, vocabulary: Vocabulary } | null = null;

/** Indexed terms, reloaded when transcripts change (also by another process, like the import script). */
async function vocabulary(db: Kysely<Database>): Promise<Vocabulary> {
	const { rows: [state] } = await sql<{ n: number, last: number | null }>`SELECT COUNT(*) AS n, MAX(updated) AS last FROM transcripts`.execute(db);
	const key = `${state.n}:${state.last}`;
	if (cached?.key !== key) {
		const { rows } = await sql<{ term: string, doc: number }>`SELECT term, doc FROM transcripts_vocab`.execute(db);
		cached = { key, vocabulary: new Map(rows.map(r => [r.term, r.doc])) };
	}
	return cached.vocabulary;
}

/** FTS5 match expressions for a search string, or null when nothing in it is searchable. */
export async function transcriptMatch(db: Kysely<Database>, query: string) {
	return ftsQuery(query, await vocabulary(db));
}

/** Posts matching `match`, as a joinable "hits" table with the best (lowest) bm25 score of their pictures. */
export const transcriptHits = (match: string) => sql<{ post: string, score: number }>`(
	SELECT t.post AS post, MIN(f.rank) AS score
	FROM (SELECT rowid, rank FROM transcripts_fts WHERE transcripts_fts MATCH ${match}) AS f
	JOIN transcripts AS t ON t.message = f.rowid
	WHERE t.post IS NOT NULL
	GROUP BY t.post
)`.as("hits");
