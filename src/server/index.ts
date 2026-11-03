import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.ts";
import { connect, ensureSchema, metaValue } from "./db.ts";
import { routes, type State } from "./api.ts";
import { TRANSCRIPT_LIMITS } from "./transcripts.ts";

const db = connect(config.dbPath);
await ensureSchema(db);
const voteSalt = await metaValue(db, "vote-salt", () => crypto.randomUUID());
await mkdir(config.mediaDir, { recursive: true });

const app = new Hono();

const respond = (c: Context, status: ContentfulStatusCode, body: string | null = null) =>
	body === null ? c.body(null, status) : c.body(body, status);

// Media keys look like "<post id>-<index>"; anything else is rejected before touching the filesystem.
const MEDIA_KEY = /^[A-Za-z0-9_.-]+$/;
const mediaPath = (key: string) => MEDIA_KEY.test(key) ? path.join(config.mediaDir, key) : null;

function sniffMediaType(head: Uint8Array): string {
	const startsWith = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
	if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (startsWith(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45) return "image/webp";
	if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "video/mp4";
	return "application/octet-stream";
}

// Same URL scheme as the worker (/r2/<key>) so the page and the feeder keep working unchanged.
app.get("/r2/:key", async c => {
	const file = mediaPath(c.req.param("key"));
	if (!file) return respond(c, 400);

	const info = await stat(file).catch(() => null);
	if (!info?.isFile()) return respond(c, 404);

	const handle = await open(file, "r");
	const head = new Uint8Array(16);
	const { bytesRead } = await handle.read(head, 0, head.length, 0);
	await handle.close();

	c.header("content-type", sniffMediaType(head.subarray(0, bytesRead)));
	c.header("content-length", `${info.size}`);
	c.header("cache-control", "public, max-age=31536000, immutable");
	return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
});

/** Constant-time comparison of a shared secret; false when the secret is not configured. */
function secretMatches(given: string | undefined, secret: string | null) {
	if (secret === null || given === undefined) return false;
	const digest = (s: string) => createHash("sha256").update(s).digest();
	return timingSafeEqual(digest(given), digest(secret));
}

const feedAuthorized = (c: Context) => secretMatches(c.req.header("x-feed-token"), config.feedToken);

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(k => typeof k === "string");

app.post("/feed/r2/:key", async c => {
	if (config.feedToken === null) return respond(c, 500, "feed token not defined");
	if (!feedAuthorized(c)) return respond(c, 401);

	const file = mediaPath(c.req.param("key"));
	if (!file) return respond(c, 400);

	await writeFile(file, new Uint8Array(await c.req.arrayBuffer()));
	return respond(c, 200);
});

const SUGGEST_COOKIE = "suggest_token";

function setSuggestCookie(c: Context, token: string, expiry: number) {
	setCookie(c, SUGGEST_COOKIE, token, {
		httpOnly: true,
		secure: config.cookieSecure,
		sameSite: "Strict",
		path: "/api/",
		maxAge: Math.max(0, Math.floor((expiry - Date.now()) / 1000))
	});
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Salted hash of the visitor's address, used to deduplicate anonymous votes.
 * X-Real-IP is only trusted from a loopback peer, i.e. the local nginx.
 */
function clientId(c: Context) {
	const peer = getConnInfo(c).remote.address ?? "";
	const forwarded = c.req.header("x-real-ip");
	const address = LOOPBACK.has(peer) && forwarded ? forwarded : peer;
	return createHash("sha256").update(`${voteSalt}:${address}`).digest("base64url");
}

const isVote = (v: unknown): v is -1 | 0 | 1 => v === -1 || v === 0 || v === 1;

app.post("*", async c => {
	const route = pickRoute(c.req.path);
	if (!route) return respond(c, 501);

	const state: State = {
		db,
		token: getCookie(c, "auth_token"),
		suggestToken: getCookie(c, SUGGEST_COOKIE),
		client: clientId(c)
	};
	const params: any = await c.req.json().catch(() => null);

	switch (route) {
		case("/api/user/vibecheck"): {
			const result = await routes[route](state);
			return c.json(result);
		}
		case("/api/user/register"): {
			if (typeof params?.login !== "string")    return respond(c, 400);
			if (typeof params?.password !== "string") return respond(c, 400);

			await routes[route](state, params.login, params.password);
			return respond(c, 200);
		}
		case("/api/user/signin"): {
			if (typeof params?.login !== "string")    return respond(c, 400);
			if (typeof params?.password !== "string") return respond(c, 400);
			if (typeof params?.info !== "string")     return respond(c, 400);

			const { result } = await routes[route](state, params.login, params.password, params.info);
			if (!result?.success) return respond(c, 401, result?.error ?? null);
			// The token travels only in the cookie; the body gets the session list.
			setCookie(c, "auth_token", result.value.token, {
				httpOnly: true,
				secure: config.cookieSecure,
				sameSite: "Strict",
				path: "/api/"
			});
			return c.json({ clearance: "ok", result: result.value.sessions });
		}
		case("/api/user/signoff"): {
			if (typeof params?.session !== "number") return respond(c, 400);

			const result = await routes[route](state, params.session);
			if (result.clearance === "ok") return respond(c, 200);
			else return respond(c, 401, result.clearance);
		}
		case("/api/user/change"): {
			if (typeof params?.newPassword !== "string") return respond(c, 400);

			const result = await routes[route](state, params.newPassword);
			if (result.clearance === "ok") return respond(c, 200);
			else return respond(c, 401, result.clearance);
		}
		case("/api/tags"): {
			const result = await routes[route](state);
			return c.json(result);
		}
		case("/api/posts"): {
			if (typeof params?.page !== "number") return respond(c, 400);

			const search = typeof params.search === "number" || typeof params.search === "string"
				? params.search
				: undefined;
			const result = await routes[route](state, params.page, search, {
				query: typeof params.query === "string" ? params.query.slice(0, 200) : undefined,
				suggested: params.suggested === true,
				recalculateCoverage: params.recalculateCoverage === true
			});
			return c.json(result);
		}
		case("/api/post/attach"): {
			if (typeof params?.post !== "string") return respond(c, 400);
			if (typeof params?.tag !== "string") return respond(c, 400);

			const result = await routes[route](state, params.post, params.tag);
			return c.json(result);
		}
		case("/api/post/untag"): {
			if (typeof params?.post !== "string") return respond(c, 400);
			if (typeof params?.tag !== "number") return respond(c, 400);

			const result = await routes[route](state, params.post, params.tag);
			return c.json(result);
		}
		case("/api/tag/rename"): {
			if (typeof params?.tag !== "number")  return respond(c, 400);
			if (typeof params?.name !== "string") return respond(c, 400);

			const result = await routes[route](state, params.tag, params.name, params.merge === true);
			return c.json(result);
		}
		case("/api/tag/delete"): {
			if (typeof params?.tag !== "number") return respond(c, 400);

			const result = await routes[route](state, params.tag);
			return c.json(result);
		}
		case("/api/transcript"): {
			if (config.transcriptToken === null) return respond(c, 503, "transcript token not defined");
			if (!secretMatches(c.req.header("x-transcript-token"), config.transcriptToken)) return respond(c, 401);
			if (!Number.isSafeInteger(params?.message) || params.message <= 0) return respond(c, 400, "message: positive integer");
			if (typeof params.text !== "string" || params.text.length > TRANSCRIPT_LIMITS.text)
				return respond(c, 400, `text: string up to ${TRANSCRIPT_LIMITS.text} characters`);
			// A list, or the transcriber's own comma-separated form.
			const keywords: unknown = typeof params.keywords === "string" ? params.keywords.split(",") : params.keywords ?? [];
			if (!isStringList(keywords) || keywords.length > TRANSCRIPT_LIMITS.keywords || keywords.some(k => k.length > TRANSCRIPT_LIMITS.keyword))
				return respond(c, 400, `keywords: up to ${TRANSCRIPT_LIMITS.keywords} strings of up to ${TRANSCRIPT_LIMITS.keyword} characters`);

			const { result } = await routes[route](state, { message: params.message, text: params.text, keywords });
			return c.json(result);
		}
		case("/feed/post"): {
			if (config.feedToken === null) return respond(c, 500, "feed token not defined");
			if (!feedAuthorized(c)) return respond(c, 401);
			if (typeof params?.caption !== "string")    return respond(c, 400);
			if (typeof params?.id !== "number")         return respond(c, 400);
			if (typeof params?.time !== "number")       return respond(c, 400);
			if (typeof params?.mediaCount !== "number") return respond(c, 400);

			await routes[route](state, params.caption, params.id, params.time, params.mediaCount);
			return respond(c, 200);
		}
		case("/api/suggest/status"): {
			const result = await routes[route](state);
			if (state.suggestToken && !result.result?.active) deleteCookie(c, SUGGEST_COOKIE, { path: "/api/" });
			return c.json(result);
		}
		case("/api/suggest/token"): {
			const result = await routes[route](state);
			if (result.result?.success && result.result.value.token) {
				setSuggestCookie(c, result.result.value.token, result.result.value.expiry);
				delete result.result.value.token;
			}
			return c.json(result);
		}
		case("/api/suggest/issue"): {
			const result = await routes[route](state);
			if (result.clearance !== "ok") return respond(c, 401, result.clearance);
			return c.json(result);
		}
		case("/api/suggest/redeem"): {
			if (typeof params?.token !== "string") return respond(c, 400);

			const result = await routes[route](state, params.token);
			if (result.result?.success) setSuggestCookie(c, params.token, result.result.value.expiry);
			return c.json(result);
		}
		case("/api/suggest/add"): {
			if (typeof params?.post !== "string") return respond(c, 400);
			if (typeof params?.tag !== "string")  return respond(c, 400);

			const result = await routes[route](state, params.post, params.tag);
			return c.json(result);
		}
		case("/api/suggest/remove"):
		case("/api/suggest/approve"):
		case("/api/suggest/reject"): {
			if (typeof params?.suggestion !== "number") return respond(c, 400);

			const result = await routes[route](state, params.suggestion);
			return c.json(result);
		}
		case("/api/suggest/vote"): {
			if (typeof params?.suggestion !== "number") return respond(c, 400);
			if (!isVote(params?.value))                 return respond(c, 400);

			const result = await routes[route](state, params.suggestion, params.value);
			return c.json(result);
		}
	}
});

// The page itself (index.html, index.js, styles.css, favicon.png).
app.get("*", serveStatic({ root: config.publicDir }));
app.all("*", c => respond(c, c.req.method === "GET" ? 404 : 405));

app.onError((err, c) => {
	console.error(err);
	return respond(c, 500);
});

const pickRoute = (pathname: string): (keyof typeof routes) | null =>
	Object.hasOwn(routes, pathname) ? pathname as keyof typeof routes : null;

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
	console.log(`catmemes listening on http://${info.address}:${info.port}`);
	console.log(`db: ${config.dbPath}\nmedia: ${config.mediaDir}`);
	if (config.feedToken === null) console.warn("FEED_TOKEN is not set; /feed/* endpoints are disabled");
	if (config.transcriptToken === null) console.warn("TRANSCRIPT_TOKEN is not set; /api/transcript is disabled");
});

const shutdown = () => { db.destroy().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
