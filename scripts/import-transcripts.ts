/**
 * One-time import of transcripts from the transcriber bot's database
 * (memes-<date>.db). Safe to run while the server is up, and to run again:
 * entries are replaced, not duplicated.
 *
 *   node --env-file-if-exists=.env scripts/import-transcripts.ts memes-2026-11-03.db
 *
 * Reads the bot's channel_memes (one row per picture, keywords as a comma
 * list) with the text from its latest meme_ocr pass, for the channel named
 * by TG_CHANNEL. Manually added memes there have no channel post and are skipped.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config.ts";
import { connect, ensureSchema } from "../src/server/db.ts";
import { writeTranscript, TRANSCRIPT_LIMITS, type TranscriptInput } from "../src/server/transcripts.ts";

const file = process.argv[2];
if (!file || !existsSync(file)) {
	console.error("usage: node --env-file-if-exists=.env scripts/import-transcripts.ts <memes.db>");
	process.exit(2);
}

const BATCH = 500;

const source = new DatabaseSync(file, { readOnly: true });
const rows = source.prepare(`
	SELECT c.message_id AS message, c.tags AS keywords, (
		SELECT o.text FROM meme_ocr AS o
		WHERE o.source = 'channel' AND o.meme_id = c.id
		ORDER BY o.prompt_version DESC LIMIT 1
	) AS text
	FROM channel_memes AS c
	WHERE c.channel = ?
	ORDER BY c.message_id
`).all(config.channel) as { message: number, keywords: string, text: string | null }[];
source.close();

if (rows.length === 0) {
	console.error(`no transcripts for channel "${config.channel}" in ${file}`);
	process.exit(1);
}

const entries: TranscriptInput[] = rows.map(r => ({
	message: r.message,
	text: (r.text ?? "").slice(0, TRANSCRIPT_LIMITS.text),
	keywords: r.keywords.split(",").slice(0, TRANSCRIPT_LIMITS.keywords).map(k => k.slice(0, TRANSCRIPT_LIMITS.keyword))
}));

const db = connect(config.dbPath);
await ensureSchema(db);
const started = Date.now();
let linked = 0, replaced = 0;
for (let i = 0; i < entries.length; i += BATCH) {
	// Batched so the server is only held off for a moment at a time.
	await db.transaction().execute(async trx => {
		for (const entry of entries.slice(i, i + BATCH)) {
			const result = await writeTranscript(trx, entry);
			if (result.post !== null) linked++;
			if (result.replaced) replaced++;
		}
	});
	console.log(`${Math.min(i + BATCH, entries.length)} / ${entries.length}`);
}
await db.destroy();

console.log(`imported ${entries.length} transcripts in ${((Date.now() - started) / 1000).toFixed(1)}s (${replaced} replaced)`);
console.log(`  ${linked} belong to known posts; ${entries.length - linked} wait for their post or predate the archive`);
