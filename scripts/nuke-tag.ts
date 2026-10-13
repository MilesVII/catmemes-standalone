import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync('data/gatos.db');

const t = "uncharted";

db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN");
const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(t);
const pairs = tag ? db.prepare("DELETE FROM pairs WHERE tag = ?").run(tag.id).changes : 0;
if (tag) db.prepare("DELETE FROM tags WHERE id = ?").run(tag.id);
const suggestions = db.prepare("DELETE FROM suggestions WHERE name = ?").run("uncharted").changes;
db.exec("COMMIT");
console.log({ pairs, suggestions });