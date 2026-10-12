import path from "node:path";

const env = (key: string, fallback: string) => process.env[key] || fallback;

const cwd = process.cwd();

const HOUR = 60 * 60 * 1000;

export const config = {
	host: env("HOST", "127.0.0.1"),
	port: Number.parseInt(env("PORT", "3000"), 10),
	dbPath: path.resolve(cwd, env("DB_PATH", "./data/gatos.db")),
	mediaDir: path.resolve(cwd, env("MEDIA_DIR", "./data/media")),
	publicDir: path.resolve(import.meta.dirname, "../../public"),
	feedToken: process.env.FEED_TOKEN || null,
	cookieSecure: env("COOKIE_SECURE", "true") !== "false",
	/** Minimum time between two publicly issued suggester tokens, site-wide. */
	suggestCooldown: Number.parseFloat(env("SUGGEST_COOLDOWN_HOURS", "6")) * HOUR,
	/** Lifetime of a suggester token. */
	suggestTtl: Number.parseFloat(env("SUGGEST_TTL_DAYS", "7")) * 24 * HOUR
};
