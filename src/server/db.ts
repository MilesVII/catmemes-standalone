import { mkdirSync } from "node:fs";
import path from "node:path";
import { Kysely, SqliteDialect, sql, type Generated } from "kysely";
import { openSqlite } from "./sqlite.ts";
import { hashPassword } from "./utils.ts";

export type Post = {
	time: number,
	id: string,
	source: string,
	caption: string,
	media: string
}
type User = {
	id: Generated<number>,
	login: string,
	password: string,
}
type Token = {
	id: Generated<number>,
	user: number,
	value: string,
	info: string,
	expiry: string
}
type Tag = {
	id: Generated<number>,
	name: string
}
type TagPair = {
	tag: number,
	post: string
}
/** Anonymous bearer token that allows suggesting tags. Times are ms since epoch. */
type Suggester = {
	id: Generated<number>,
	value: string,
	created: number,
	expiry: number,
	/** 1 when issued by an admin; those do not count towards the public cooldown. */
	admin: number
}
/** A tag proposed for a post, not yet part of tags/pairs. */
type Suggestion = {
	id: Generated<number>,
	post: string,
	name: string,
	suggester: number,
	created: number
}
type Vote = {
	suggestion: number,
	/** "ip:<salted hash of the client address>" */
	voter: string,
	value: number
}
type Meta = {
	key: string,
	value: string
}
/** Text found in one channel picture, from the transcriber bot. See transcripts.ts. */
type Transcript = {
	/** Telegram message id; an album has one per picture */
	message: number,
	/** "tg<id>" once the post is known */
	post: string | null,
	text: string,
	/** JSON array of strings */
	keywords: string,
	/** ms since epoch */
	updated: number
}

export type Database = {
	posts: Post,
	tags: Tag,
	pairs: TagPair,
	users: User,
	tokens: Token,
	suggesters: Suggester,
	suggestions: Suggestion,
	votes: Vote,
	meta: Meta,
	transcripts: Transcript
}

export function connect(file: string): Kysely<Database> {
	mkdirSync(path.dirname(file), { recursive: true });
	return new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(file) }) });
}

/** Creates the schema (and the default admin user) when the database is empty. */
export async function ensureSchema(db: Kysely<Database>) {
	const tables = await db.introspection.getTables();
	if (!tables.some(t => t.name === "posts")) {
		console.log("empty database, creating schema with user admin / <empty password>");
		await migrations.create(db);
	}
	// A post carries a tag at most once. Older databases may hold duplicates
	// from before this was enforced, so they are folded before the index is built.
	await sql`DELETE FROM "pairs" WHERE rowid NOT IN (SELECT MIN(rowid) FROM "pairs" GROUP BY "post", "tag")`.execute(db);
	await sql`DROP INDEX IF EXISTS "pairs-post"`.execute(db);
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS "pairs-post-tag" ON "pairs" ("post", "tag")`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS "pairs-tag" ON "pairs" ("tag")`.execute(db);
	// Feed order (time desc, id desc): lets a page be read without sorting every post.
	await sql`CREATE INDEX IF NOT EXISTS "posts-order" ON "posts" ("time", "id")`.execute(db);

	// Tag suggestions. Created on every start so existing databases pick them up.
	await db.schema
		.createTable("suggesters")
		.ifNotExists()
		.addColumn("id", "integer", c => c.primaryKey().autoIncrement())
		.addColumn("value", "text", c => c.notNull().unique())
		.addColumn("created", "integer", c => c.notNull())
		.addColumn("expiry", "integer", c => c.notNull())
		.addColumn("admin", "integer", c => c.notNull().defaultTo(0))
		.execute();

	await db.schema
		.createTable("suggestions")
		.ifNotExists()
		.addColumn("id", "integer", c => c.primaryKey().autoIncrement())
		.addColumn("post", "text", c => c.notNull())
		.addColumn("name", "text", c => c.notNull())
		.addColumn("suggester", "integer", c => c.notNull())
		.addColumn("created", "integer", c => c.notNull())
		.addForeignKeyConstraint("suggestion-post", ["post"], "posts", ["id"])
		.addForeignKeyConstraint("suggestion-suggester", ["suggester"], "suggesters", ["id"])
		.addUniqueConstraint("suggestion-unique", ["post", "name"])
		.execute();
	await sql`CREATE INDEX IF NOT EXISTS "suggestions-suggester" ON "suggestions" ("suggester")`.execute(db);
	// Tag search and the pending counts in the tag list go by name.
	await sql`CREATE INDEX IF NOT EXISTS "suggestions-name" ON "suggestions" ("name")`.execute(db);

	await db.schema
		.createTable("votes")
		.ifNotExists()
		.addColumn("suggestion", "integer", c => c.notNull())
		.addColumn("voter", "text", c => c.notNull())
		.addColumn("value", "integer", c => c.notNull())
		.addPrimaryKeyConstraint("vote-pk", ["suggestion", "voter"])
		.addForeignKeyConstraint(
			"vote-suggestion",
			["suggestion"], "suggestions", ["id"],
			fk => fk.onDelete("cascade")
		)
		.execute();

	await db.schema
		.createTable("meta")
		.ifNotExists()
		.addColumn("key", "text", c => c.primaryKey())
		.addColumn("value", "text", c => c.notNull())
		.execute();

	await db.schema
		.createTable("transcripts")
		.ifNotExists()
		.addColumn("message", "integer", c => c.primaryKey())
		.addColumn("post", "text", c => c.references("posts.id"))
		.addColumn("text", "text", c => c.notNull())
		.addColumn("keywords", "text", c => c.notNull())
		.addColumn("updated", "integer", c => c.notNull())
		.execute();
	await sql`CREATE INDEX IF NOT EXISTS "transcripts-post" ON "transcripts" ("post")`.execute(db);
	// Terms are stemmed before they get here (search.ts); the tokenizer only splits on spaces.
	// Contentless: the index is all that is needed, the text itself lives in "transcripts".
	await sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(terms, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 0')`.execute(db);
	await sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_vocab USING fts5vocab(transcripts_fts, row)`.execute(db);
}

/** Reads a persistent setting, creating it with `init()` on first use. */
export async function metaValue(db: Kysely<Database>, key: string, init: () => string) {
	await db
		.insertInto("meta")
		.values({ key, value: init() })
		.onConflict(oc => oc.column("key").doNothing())
		.execute();
	const row = await db
		.selectFrom("meta")
		.select("value")
		.where("key", "=", key)
		.executeTakeFirstOrThrow();
	return row.value;
}

export const migrations: Record<string, (db: Kysely<Database>) => Promise<void>> = {
	create: async db => {
		await db.schema.dropTable("pairs").ifExists().execute();
		await db.schema.dropTable("tokens").ifExists().execute();
		await db.schema.dropTable("posts").ifExists().execute();
		await db.schema.dropTable("tags").ifExists().execute();
		await db.schema.dropTable("users").ifExists().execute();

		await db.schema
			.createTable("posts")
			.addColumn("id", "text", c => c.primaryKey())
			.addColumn("time", "integer")
			.addColumn("source", "text")
			.addColumn("caption", "text")
			.addColumn("media", "text")
			.execute();

		await db.schema
			.createTable("tags")
			.addColumn("id", "integer", c => c.primaryKey().autoIncrement())
			.addColumn("name", "text")
			.addUniqueConstraint("tag-name-unique", ["name"])
			.execute();

		await db.schema
			.createTable("pairs")
			.addColumn("tag", "integer")
			.addForeignKeyConstraint("tag-foreign", ["tag"], "tags", ["id"])
			.addColumn("post", "text")
			.addForeignKeyConstraint("post-foreign", ["post"], "posts", ["id"])
			.execute();

		await db.schema
			.createTable("users")
			.addColumn("id", "integer", c => c.primaryKey().autoIncrement())
			.addColumn("login", "text")
			.addColumn("password", "text")
			.execute();

		await db.schema
			.createTable("tokens")
			.addColumn("id", "integer", c => c.primaryKey().autoIncrement())
			.addColumn("user", "integer")
			.addForeignKeyConstraint(
				"user-foreign",
				["user"], "users", ["id"]
			)
			.addColumn("value", "text")
			.addColumn("info", "text")
			.addColumn("expiry", "text")
			.execute();

		await db
			.insertInto("users")
			.values({ login: "admin", password: await hashPassword("") })
			.execute();
	}
}

export async function getMeta(db: Kysely<Database>, key: string) {
	const row = await db.selectFrom("meta").select("value").where("key", "=", key).executeTakeFirst();
	return row?.value ?? null;
}

export async function setMeta(db: Kysely<Database>, key: string, value: string) {
	await db
		.insertInto("meta")
		.values({ key, value })
		.onConflict(oc => oc.column("key").doUpdateSet({ value }))
		.execute();
}
