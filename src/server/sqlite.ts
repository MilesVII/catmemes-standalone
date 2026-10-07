import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteStatement } from "kysely";

/**
 * Adapts Node's built-in `node:sqlite` to the better-sqlite3-shaped interface
 * Kysely's SqliteDialect expects. No native addon needed.
 */
export function openSqlite(file: string): SqliteDatabase & { raw: DatabaseSync } {
	const raw = new DatabaseSync(file);
	raw.exec("PRAGMA journal_mode = WAL");
	raw.exec("PRAGMA foreign_keys = ON");
	raw.exec("PRAGMA busy_timeout = 5000");

	return {
		raw,
		close: () => raw.close(),
		prepare: (sql: string): SqliteStatement => {
			const stmt = raw.prepare(sql);
			return {
				// Statements that produce rows report their columns; everything else is "run"-only.
				reader: stmt.columns().length > 0,
				all: (params) => stmt.all(...(params as never[])),
				run: (params) => stmt.run(...(params as never[])),
				iterate: (params) => stmt.iterate(...(params as never[]))
			};
		}
	};
}
