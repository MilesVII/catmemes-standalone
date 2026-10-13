/**
 * Resets a user's password and ends their sessions.
 *
 *   node --env-file-if-exists=.env scripts/reset-pw.ts [login] [password]
 *
 * Defaults to the user "admin" and an empty password.
 */
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config.ts";
import { hashPassword } from "../src/server/utils.ts";

const [login = "admin", password = ""] = process.argv.slice(2);

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const updated = db.prepare("UPDATE users SET password = ? WHERE login = ?").run(await hashPassword(password), login);
db.prepare("DELETE FROM tokens WHERE user IN (SELECT id FROM users WHERE login = ?)").run(login);
db.close();
console.log(updated.changes ? `password of ${login} updated, sessions ended` : `no such user: ${login}`);
