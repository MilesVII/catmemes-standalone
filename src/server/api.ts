import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from "kysely";
import type { Post, Database } from "./db.ts";
import { config } from "./config.ts";
import { password, type Result } from "./utils.ts";

const POSTS_PER_PAGE = 20;
const TAG_MAX_LENGTH = 64;
const SUGGESTIONS_PER_TOKEN = 300;

export type State = {
	db: Kysely<Database>,
	/** Admin session cookie. */
	token?: string,
	/** Suggester token cookie. */
	suggestToken?: string,
	/** Salted hash of the client address; identifies anonymous voters. */
	client: string
};

type Clearance = "expired" | "nope" | "ok";
type ProtectedResult<T> = {
	clearance: Clearance,
	result: T | null
};

type Route<T extends any[], R> = (state: State, ...rest: T) => Promise<R>;
function guarded<T extends any[], R>(
	protectedRoute: boolean,
	core: Route<T, R>
): (state: State, ...rest: T) => Promise<ProtectedResult<R>> {
	return async (state: State, ...rest: T) => {
		if (protectedRoute) {
			const [clearance] = await auth(state);
			if (clearance !== "ok") return { clearance, result: null }
		}
		return { clearance: "ok", result: await core(state, ...rest)}
	}
};

export const routes = {
	"/api/user/vibecheck": guarded(false, vibecheck),
	"/api/user/register" : guarded( true, register),
	"/api/user/signin"   : guarded(false, signin),
	"/api/user/signoff"  : guarded( true, signoff),
	"/api/user/change"   : guarded( true, changePassword),
	"/api/tags"          : guarded(false, listTags),
	"/api/posts"         : guarded(false, listPosts),
	"/api/post/attach"   : guarded( true, attachTag),
	"/api/post/untag"    : guarded( true, untag),
	"/feed/post"         : guarded(false, feedPost), // protected by feed token
	"/proxy"             : guarded(false, proxy),

	"/api/suggest/status" : guarded(false, suggestStatus),
	"/api/suggest/token"  : guarded(false, requestSuggester), // rate limited by the global cooldown
	"/api/suggest/issue"  : guarded( true, issueSuggester),
	"/api/suggest/redeem" : guarded(false, redeemSuggester),
	"/api/suggest/add"    : guarded(false, addSuggestion),    // protected by suggester token
	"/api/suggest/remove" : guarded(false, removeSuggestion), // protected by suggester token
	"/api/suggest/vote"   : guarded(false, voteSuggestion),
	"/api/suggest/approve": guarded( true, approveSuggestion),
	"/api/suggest/reject" : guarded( true, rejectSuggestion)
};

async function auth({ db, token }: State): Promise<[Clearance, number | null]> {
	if (!token) return ["nope", null]
	const entry = await db
		.selectFrom("tokens")
		.select(["user", "value", "expiry"])
		.where("value", "=", token)
		.executeTakeFirst();
	if (!entry) return ["nope", null];
	if (entry.expiry !== "none") return ["expired", null];
	return ["ok", entry.user];
}
type Sessions = Awaited<ReturnType<typeof getSessions>>;
async function getSessions({ db, token }: State, user: number) {
	const tokens = await db
		.selectFrom("tokens")
		.select(["info", "id", "value"])
		.where("user", "=", user)
		.execute();
	return tokens
		.sort((_, t) => t.value === token ? 1 : -1)
		.map(t => ({ id: t.id, info: t.info }));
}

async function vibecheck(state: State): Promise<Sessions | null> {
	const [status, user] = await auth(state);
	return status === "ok" ? await getSessions(state, user!) : null;
}

async function register(state: State, login: string, pwd: string): Promise<boolean> {
	const { db } = state;
	await db
		.insertInto("users")
		.values({ login, password: await password(pwd) })
		.execute();
	return true;
}

async function signin(state: State, login: string, pwd: string, info: string): Promise<Result<{ token?: string, sessions: Sessions }, "nouser" | "password">> {
	const { db } = state;
	const user = await db
		.selectFrom("users")
		.selectAll()
		.where("login", "=", login)
		.executeTakeFirst();
	if (!user) return { success: false, error: "nouser" };
	if (user.password !== await password(pwd)) return { success: false, error: "password" };

	const token = crypto.randomUUID();
	await db
		.insertInto("tokens")
		.values({ user: user.id, value: token, info, expiry: "none" })
		.execute();
	const sessions = await getSessions(state, user.id);

	return { success: true, value: { token, sessions } };
}

async function signoff({ db, token }: State, session: number): Promise<boolean> {
	if (!token) return false;
	await db.deleteFrom("tokens").where("id", "=", session).execute();
	return true;
}

async function changePassword({ db, token }: State, newPassword: string): Promise<boolean> {
	if (!token) return false;
	const user = await db
		.selectFrom("tokens")
		.select(["user", "value"])
		.where("value", "=", token)
		.executeTakeFirst();
	if (!user) return false;

	await db
		.updateTable("users")
		.where("id", "=", user.user)
		.set("password", await password(newPassword))
		.execute();
	await db
		.deleteFrom("tokens")
		.where("user", "=", user.user)
		.execute();
	return true;
}

type TagEntry = {
	/** null for names that so far exist only as suggestions */
	id: number | null,
	name: string,
	/** posts with the approved tag */
	count: number,
	/** posts where the name is a pending suggestion */
	suggested: number
};

async function listTags({ db }: State): Promise<TagEntry[]> {
	const approved = await db
		.selectFrom("tags")
		.leftJoin("pairs", "pairs.tag", "tags.id")
		.select([
			"tags.id as id",
			"tags.name as name",
			sql<number>`COUNT(pairs.tag)`.as("count")
		])
		.groupBy(["tags.id", "tags.name"])
		.execute();
	const pending = await db
		.selectFrom("suggestions")
		.select(["name", sql<number>`COUNT(*)`.as("suggested")])
		.groupBy("name")
		.execute();

	const byName = new Map<string, TagEntry>(
		approved.map(t => [t.name, { id: t.id, name: t.name, count: t.count, suggested: 0 }])
	);
	for (const p of pending) {
		const entry = byName.get(p.name);
		if (entry) entry.suggested = p.suggested;
		else byName.set(p.name, { id: null, name: p.name, count: 0, suggested: p.suggested });
	}
	// count + suggested is what a default search finds: a post never has both for one name.
	return [...byName.values()].sort((a, b) =>
		(b.count + b.suggested) - (a.count + a.suggested) || b.count - a.count
	);
}

export type PostListOptions = {
	/** Tag search matches approved tags only, skipping pending suggestions. */
	approvedOnly?: boolean,
	/** Admin only: restrict the list to posts with pending suggestions. */
	suggested?: boolean,
	/** Admin only: include per-page tag coverage of the whole (filtered) list. */
	coverage?: boolean
};

/**
 * Search is by tag name, so it can find names that exist only as suggestions.
 * A number is still accepted as a tag id (old links). Returns undefined for
 * "no search" and null for a search that cannot match anything.
 */
async function resolveSearch(db: Kysely<Database>, search: unknown): Promise<string | null | undefined> {
	if (typeof search === "string") {
		const name = search.trim().toLowerCase();
		return name.length > 0 ? name : undefined;
	}
	if (typeof search === "number") {
		const row = await db.selectFrom("tags").select("name").where("id", "=", search).executeTakeFirst();
		return row?.name ?? null;
	}
	return undefined;
}

function postFilter(
	db: Kysely<Database>,
	tagName: string | null | undefined,
	includeSuggested: boolean,
	suggestedOnly: boolean
) {
	return (eb: ExpressionBuilder<Database, "posts">) => {
		const conditions: Expression<SqlBool>[] = [];
		if (tagName === null)
			conditions.push(sql<SqlBool>`0 = 1`);
		else if (tagName !== undefined) {
			const approved = eb(
				"posts.id", "in",
				db
					.selectFrom("pairs as pt")
					.innerJoin("tags as tt", "tt.id", "pt.tag")
					.where("tt.name", "=", tagName)
					.select("pt.post")
			);
			conditions.push(includeSuggested
				? eb.or([
					approved,
					eb("posts.id", "in", db.selectFrom("suggestions as st").where("st.name", "=", tagName).select("st.post"))
				])
				: approved
			);
		}
		if (suggestedOnly)
			conditions.push(eb(
				"posts.id", "in",
				db.selectFrom("suggestions as ps").select("ps.post")
			));
		return eb.and(conditions);
	};
}
type PostFilter = ReturnType<typeof postFilter>;

async function listPosts(state: State, page: number, search?: number | string, options: PostListOptions = {}) {
	const { db } = state;
	const [clearance] = await auth(state);
	const admin = clearance === "ok";
	const filter = postFilter(
		db,
		await resolveSearch(db, search),
		options.approvedOnly !== true,
		admin && options.suggested === true
	);

	const countRow = await db
		.selectFrom("posts")
		.where(filter)
		.select(sql<number>`COUNT(*)`.as("total"))
		.executeTakeFirst();
	const count = countRow?.total ?? 0

	// Single-quoted key names: Node's bundled SQLite is built with SQLITE_DQS=0,
	// so double-quoted strings are identifiers only (D1 tolerated them).
	const rows = await db
		.selectFrom("posts")
		.leftJoin("pairs", "pairs.post", "posts.id")
		.leftJoin("tags", "tags.id", "pairs.tag")
		.where(filter)
		.select([
			"posts.id",
			"posts.caption",
			"posts.media",
			"posts.source",
			sql<string>`
				json_group_array(
					json_object('tagId', tags.id, 'tagName', tags.name)
				)
			`.as("tags")
		])
		.groupBy("posts.id")
		.limit(POSTS_PER_PAGE)
		.offset(page * POSTS_PER_PAGE)
		.orderBy("posts.time", "desc")
		.orderBy("posts.id", "desc") // must match the ordering in tagCoverage
		.execute();

	const suggestions = await suggestionsFor(state, rows.map(r => r.id), admin);
	const posts = rows.map(r => ({ ...r, suggestions: suggestions.get(r.id) ?? [] }));
	const coverage = admin && options.coverage ? await tagCoverage(db, filter) : undefined;

	return { count, posts, perPage: POSTS_PER_PAGE, coverage };
}

/** Number of posts with at least one tag on every page of the list, page 0 first. */
async function tagCoverage(db: Kysely<Database>, filter: PostFilter) {
	const rows = await db
		.with("ordered", qc => qc
			.selectFrom("posts")
			.where(filter)
			.select([
				sql<number>`(ROW_NUMBER() OVER (ORDER BY posts.time DESC, posts.id DESC) - 1) / ${sql.lit(POSTS_PER_PAGE)}`.as("page"),
				sql<number>`EXISTS (SELECT 1 FROM pairs WHERE pairs.post = posts.id)`.as("tagged")
			])
		)
		.selectFrom("ordered")
		.select(["page", sql<number>`SUM(tagged)`.as("tagged")])
		.groupBy("page")
		.orderBy("page")
		.execute();
	return rows.map(r => r.tagged);
}

async function attachTag({ db }: State, post: string, tag: string) {
	const tagSanitized = tag.trim().toLowerCase();
	let id = await db
		.selectFrom("tags")
		.select("id")
		.where("name", "=", tagSanitized)
		.executeTakeFirst();

	if (!id) {
		const newTag = await db
			.insertInto("tags")
			.values({ name: tagSanitized })
			.executeTakeFirst();
		if (typeof newTag.insertId !== "bigint") return;
		id = { id: Number(newTag.insertId) };
	}
	const paired = await db
		.selectFrom("pairs")
		.select("tag")
		.where("post", "=", post)
		.where("tag", "=", id.id)
		.executeTakeFirst();
	if (!paired)
		await db
			.insertInto("pairs")
			.values({ post, tag: id.id })
			.executeTakeFirst();
	// A pending suggestion of the same tag is now redundant (this is also how approval works).
	await db
		.deleteFrom("suggestions")
		.where("post", "=", post)
		.where("name", "=", tagSanitized)
		.execute();
}

async function untag({ db }: State, post: string, tag: number) {
	await db
		.deleteFrom("pairs")
		.where("post", "=", post)
		.where("tag", "=", tag)
		.execute();
	const exists = await db
		.selectFrom("pairs")
		.selectAll()
		.where("tag", "=", tag)
		.executeTakeFirst();
	if (!exists) {
		await db
			.deleteFrom("tags")
			.where("id", "=", tag)
			.execute();
	}
}

async function feedPost({ db }: State, caption: string, id: number, time: number, mediaCount: number) {
	const existing = await db
		.selectFrom("posts")
		.selectAll()
		.where("id", "=", `tg${id}`)
		.executeTakeFirst();
	if (existing) return;

	const post: Post = {
		caption,
		id: `tg${id}`,
		media: Array.from({length: mediaCount}).map(() => "-/-").join("\n"),
		source: `https://t.me/memyprokotow/${id}`,
		time: time
	};

	await db.insertInto("posts").values(post).execute();
}

async function proxy(_: State, url: string) {
	const response = await fetch(url);
	return response.ok ? await response.bytes() : null;
}

// ---- tag suggestions ----

type SuggestionView = {
	id: number,
	name: string,
	/** Suggested by the current suggester token; the author may remove it. */
	mine: boolean,
	/** The current visitor's vote: -1, 0 or 1. */
	myVote: number,
	/** Vote tallies, only sent to admins. */
	up?: number,
	down?: number
};

async function currentSuggester({ db, suggestToken }: State) {
	if (!suggestToken) return null;
	const row = await db
		.selectFrom("suggesters")
		.select(["id", "expiry"])
		.where("value", "=", suggestToken)
		.where("expiry", ">", Date.now())
		.executeTakeFirst();
	return row ?? null;
}
/**
 * Votes are keyed by the hashed client address only, so getting (or losing) a
 * suggester token does not give a visitor a second vote.
 */
const voterKey = (state: State) => `ip:${state.client}`;

async function suggestionsFor(state: State, postIds: string[], admin: boolean) {
	const byPost = new Map<string, SuggestionView[]>();
	if (postIds.length === 0) return byPost;

	const suggester = await currentSuggester(state);
	const voter = voterKey(state);
	const rows = await state.db
		.selectFrom("suggestions as s")
		.leftJoin("votes as v", "v.suggestion", "s.id")
		.where("s.post", "in", postIds)
		.select([
			"s.id",
			"s.post",
			"s.name",
			"s.suggester",
			sql<number>`COALESCE(SUM(v.value > 0), 0)`.as("up"),
			sql<number>`COALESCE(SUM(v.value < 0), 0)`.as("down"),
			sql<number | null>`MAX(CASE WHEN v.voter = ${voter} THEN v.value END)`.as("myVote")
		])
		.groupBy("s.id")
		.orderBy("s.id")
		.execute();

	for (const row of rows) {
		const view: SuggestionView = {
			id: row.id,
			name: row.name,
			mine: suggester !== null && row.suggester === suggester.id,
			myVote: row.myVote ?? 0
		};
		if (admin) {
			view.up = row.up;
			view.down = row.down;
		}
		const list = byPost.get(row.post) ?? [];
		list.push(view);
		byPost.set(row.post, list);
	}
	return byPost;
}

/** Milliseconds until a token can be issued publicly again. */
async function cooldownLeft(db: Kysely<Database>) {
	const row = await db
		.selectFrom("suggesters")
		.where("admin", "=", 0)
		.select(sql<number | null>`MAX(created)`.as("last"))
		.executeTakeFirst();
	const last = row?.last ?? null;
	return last === null ? 0 : Math.max(0, last + config.suggestCooldown - Date.now());
}

async function createSuggester(db: Kysely<Database>, admin: boolean) {
	const created = Date.now();
	const token = crypto.randomUUID();
	const expiry = created + config.suggestTtl;
	await db
		.insertInto("suggesters")
		.values({ value: token, created, expiry, admin: admin ? 1 : 0 })
		.execute();
	return { token, expiry };
}

type SuggestStatus = {
	active: { expiry: number } | null,
	cooldown: number
};
async function suggestStatus(state: State): Promise<SuggestStatus> {
	const suggester = await currentSuggester(state);
	return {
		active: suggester ? { expiry: suggester.expiry } : null,
		cooldown: await cooldownLeft(state.db)
	};
}

type IssueResult = Result<{ token?: string, expiry: number }, { cooldown: number }>;

/** Public: issues a token unless anyone got one within the cooldown. A visitor who already holds a valid token keeps it. */
async function requestSuggester(state: State): Promise<IssueResult> {
	const existing = await currentSuggester(state);
	if (existing) return { success: true, value: { expiry: existing.expiry } };

	// The transaction holds the connection, so concurrent requests cannot both pass the check.
	return await state.db.transaction().execute(async (trx): Promise<IssueResult> => {
		const cooldown = await cooldownLeft(trx);
		if (cooldown > 0) return { success: false, error: { cooldown } };
		return { success: true, value: await createSuggester(trx, false) };
	});
}

/** Admin: issues a token regardless of the cooldown, to be handed out as a link. */
async function issueSuggester(state: State) {
	return await createSuggester(state.db, true);
}

async function redeemSuggester({ db }: State, token: string): Promise<Result<{ expiry: number }, "invalid">> {
	const row = await db
		.selectFrom("suggesters")
		.select("expiry")
		.where("value", "=", token)
		.where("expiry", ">", Date.now())
		.executeTakeFirst();
	return row ? { success: true, value: { expiry: row.expiry } } : { success: false, error: "invalid" };
}

type SuggestError = "nosuggester" | "invalid" | "nopost" | "exists" | "limit" | "notfound" | "own";

async function addSuggestion(state: State, post: string, tag: string): Promise<Result<{ id: number }, SuggestError>> {
	const name = tag.trim().toLowerCase();
	if (name.length === 0 || name.length > TAG_MAX_LENGTH) return { success: false, error: "invalid" };

	const suggester = await currentSuggester(state);
	if (!suggester) return { success: false, error: "nosuggester" };

	return await state.db.transaction().execute(async (trx): Promise<Result<{ id: number }, SuggestError>> => {
		const postRow = await trx.selectFrom("posts").select("id").where("id", "=", post).executeTakeFirst();
		if (!postRow) return { success: false, error: "nopost" };

		const tagged = await trx
			.selectFrom("pairs")
			.innerJoin("tags", "tags.id", "pairs.tag")
			.select("pairs.tag")
			.where("pairs.post", "=", post)
			.where("tags.name", "=", name)
			.executeTakeFirst();
		const suggested = await trx
			.selectFrom("suggestions")
			.select("id")
			.where("post", "=", post)
			.where("name", "=", name)
			.executeTakeFirst();
		if (tagged || suggested) return { success: false, error: "exists" };

		const used = await trx
			.selectFrom("suggestions")
			.select(sql<number>`COUNT(*)`.as("n"))
			.where("suggester", "=", suggester.id)
			.executeTakeFirstOrThrow();
		if (used.n >= SUGGESTIONS_PER_TOKEN) return { success: false, error: "limit" };

		const inserted = await trx
			.insertInto("suggestions")
			.values({ post, name, suggester: suggester.id, created: Date.now() })
			.executeTakeFirstOrThrow();
		return { success: true, value: { id: Number(inserted.insertId) } };
	});
}

async function removeSuggestion(state: State, id: number): Promise<Result<true, SuggestError>> {
	const suggester = await currentSuggester(state);
	if (!suggester) return { success: false, error: "nosuggester" };

	const result = await state.db
		.deleteFrom("suggestions")
		.where("id", "=", id)
		.where("suggester", "=", suggester.id)
		.executeTakeFirst();
	return result.numDeletedRows > 0n ? { success: true, value: true } : { success: false, error: "notfound" };
}

async function voteSuggestion(state: State, id: number, value: -1 | 0 | 1): Promise<Result<true, SuggestError>> {
	const { db } = state;
	const suggestion = await db.selectFrom("suggestions").select("suggester").where("id", "=", id).executeTakeFirst();
	if (!suggestion) return { success: false, error: "notfound" };

	const suggester = await currentSuggester(state);
	if (suggester && suggester.id === suggestion.suggester) return { success: false, error: "own" };

	const voter = voterKey(state);
	if (value === 0)
		await db.deleteFrom("votes").where("suggestion", "=", id).where("voter", "=", voter).execute();
	else
		await db
			.insertInto("votes")
			.values({ suggestion: id, voter, value })
			.onConflict(oc => oc.columns(["suggestion", "voter"]).doUpdateSet({ value }))
			.execute();
	return { success: true, value: true };
}

/** Admin: turns the suggestion into a regular tag. */
async function approveSuggestion(state: State, id: number): Promise<Result<true, SuggestError>> {
	return await state.db.transaction().execute(async (trx): Promise<Result<true, SuggestError>> => {
		const suggestion = await trx
			.selectFrom("suggestions")
			.select(["post", "name"])
			.where("id", "=", id)
			.executeTakeFirst();
		if (!suggestion) return { success: false, error: "notfound" };

		// attachTag also deletes the suggestion; its votes go with it (on delete cascade).
		await attachTag({ ...state, db: trx }, suggestion.post, suggestion.name);
		return { success: true, value: true };
	});
}

async function rejectSuggestion({ db }: State, id: number): Promise<Result<true, SuggestError>> {
	const result = await db.deleteFrom("suggestions").where("id", "=", id).executeTakeFirst();
	return result.numDeletedRows > 0n ? { success: true, value: true } : { success: false, error: "notfound" };
}
