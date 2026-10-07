import { createReadStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.ts";
import { connect, ensureSchema } from "./db.ts";
import { routes, type State } from "./api.ts";

const db = connect(config.dbPath);
await ensureSchema(db);
await mkdir(config.mediaDir, { recursive: true });

const app = new Hono();

const respond = (c: Context, status: number, body: string | Uint8Array | null = null) =>
	c.body(body as any, status as any);

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

const feedAuthorized = (c: Context) =>
	config.feedToken !== null && c.req.header("x-feed-token") === config.feedToken;

app.all("/feed/r2/:key", async c => {
	if (config.feedToken === null) return respond(c, 500, "feed token not defined");
	if (!feedAuthorized(c)) return respond(c, 401);

	const file = mediaPath(c.req.param("key"));
	if (!file) return respond(c, 400);

	await writeFile(file, new Uint8Array(await c.req.arrayBuffer()));
	return respond(c, 200);
});

app.post("*", async c => {
	const route = pickRoute(c.req.path);
	if (!route) return respond(c, 501);

	const token = getCookie(c, "auth_token");
	const state: State = { db, token };
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

			const result = await routes[route](state, params.login, params.password, params.info);
			if (result.clearance !== "ok") return respond(c, 401, result.clearance);
			if (result.result?.success) {
				const token = result.result.value.token!;
				delete result.result.value.token;
				setCookie(c, "auth_token", token, {
					httpOnly: true,
					secure: config.cookieSecure,
					sameSite: "Strict",
					path: "/api/"
				});
				return c.json(result);
			} else
				return respond(c, 401, result.result?.error ?? null);
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

			const result = await routes[route](state, params.page, params.search);
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
		case("/proxy"): {
			if (typeof params?.url !== "string") return respond(c, 400);

			const result = await routes[route](state, params.url);
			return respond(c, 200, result.result);
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

function pickRoute(pathname: string): (keyof typeof routes) | null {
	if (!Object.keys(routes).includes(pathname)) {
		return null;
	}
	return pathname as keyof typeof routes;
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
	console.log(`catmemes listening on http://${info.address}:${info.port}`);
	console.log(`db: ${config.dbPath}\nmedia: ${config.mediaDir}`);
	if (config.feedToken === null) console.warn("FEED_TOKEN is not set; /feed/* endpoints are disabled");
});

const shutdown = () => { db.destroy().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
