/**
 * Loads a D1 export (`wrangler d1 export gatos --remote --output=backup.sql`)
 * into the local SQLite database.
 *
 *   npm run db:import -- ../backup.sql            # requires DB_PATH not to exist yet
 *   npm run db:import -- ../backup.sql --replace  # deletes the existing DB first
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { config } from "../src/server/config.ts";
import { connect, ensureSchema } from "../src/server/db.ts";
import { openSqlite } from "../src/server/sqlite.ts";

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const dump = args.find(a => !a.startsWith("--"));

if (!dump) {
	console.error("usage: import-sql.ts <dump.sql> [--replace]");
	process.exit(2);
}
if (existsSync(config.dbPath)) {
	if (!replace) {
		console.error(`${config.dbPath} already exists; pass --replace to overwrite it`);
		process.exit(1);
	}
	for (const suffix of ["", "-wal", "-shm"]) rmSync(config.dbPath + suffix, { force: true });
}

mkdirSync(path.dirname(config.dbPath), { recursive: true });

const sqlText = readFileSync(dump, "utf8");
const statements = sqlText.split(/;\s*\n/).filter(s => s.trim().length > 0);
console.log(`importing ${statements.length} statements from ${dump} into ${config.dbPath}`);

const { raw } = openSqlite(config.dbPath);
raw.exec("PRAGMA foreign_keys = OFF");
raw.exec("BEGIN");
try {
	raw.exec(sqlText);
	raw.exec("COMMIT");
} catch (e) {
	raw.exec("ROLLBACK");
	throw e;
}
raw.exec("PRAGMA foreign_keys = ON");

const counts = Object.fromEntries(
	["posts", "tags", "pairs", "users", "tokens"].map(t => [
		t,
		(raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
	])
);
raw.close();
console.log("imported:", counts);

// Adds the indexes the standalone build expects.
const db = connect(config.dbPath);
await ensureSchema(db);
await db.destroy();
