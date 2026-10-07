import { sql, type Kysely } from "kysely";
import type { Post, Database } from "./db.ts";
import { password, type Result } from "./utils.ts";

const POSTS_PER_PAGE = 20;

export type State = {
	db: Kysely<Database>,
	token?: string
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
	"/proxy"             : guarded(false, proxy)
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

async function listTags({ db }: State) {
	return await db
		.selectFrom("tags")
		.leftJoin("pairs", "pairs.tag", "tags.id")
		.select([
			"tags.id as id",
			"tags.name as name",
			sql<number>`COUNT(pairs.tag)`.as("count")
		])
		.groupBy(["tags.id", "tags.name"])
		.orderBy("count", "desc")
		.execute();
}

async function listPosts({ db }: State, page: number, tagSearch?: number) {
	const searching = typeof tagSearch === "number";
	let countQuery = db
		.selectFrom("posts");
	if (searching)
		countQuery = countQuery
			.leftJoin("pairs", "pairs.post", "posts.id")
			.where("pairs.tag", "=", tagSearch);
	const countRow = await countQuery
		.select(sql<number>`COUNT(*)`.as("total"))
		.executeTakeFirst();
	const count = countRow?.total ?? 0

	let selectQuery = db
		.selectFrom("posts")
		.leftJoin("pairs", "pairs.post", "posts.id")
		.leftJoin("tags", "tags.id", "pairs.tag");
	if (searching)
		selectQuery = selectQuery.where(
			"posts.id", "in",
			db
				.selectFrom("pairs as pt")
				.where("pt.tag", "=", tagSearch)
				.select("pt.post")
		);
	// Single-quoted key names: Node's bundled SQLite is built with SQLITE_DQS=0,
	// so double-quoted strings are identifiers only (D1 tolerated them).
	const result = await selectQuery
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
		.execute();

	return { count, posts: result, perPage: POSTS_PER_PAGE };
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
	await db
		.insertInto("pairs")
		.values({ post, tag: id.id })
		.executeTakeFirst();
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
