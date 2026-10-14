/**
 * Signs a Telegram account in once and prints the session string for
 * TG_SESSION. Run it on your own machine, then put the value into the
 * server's .env by hand; nothing is written here.
 *
 *   TG_API_ID=... TG_API_HASH=... node scripts/tg-login.ts
 *
 * The string is full access to the account, so use a throwaway one: reading
 * a public channel needs no particular account.
 */
import { createInterface } from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => rl.question(q).then(a => a.trim());

const apiId = Number.parseInt(process.env.TG_API_ID || await ask("api id (my.telegram.org): "), 10);
const apiHash = process.env.TG_API_HASH || await ask("api hash: ");
if (!apiId || !apiHash) {
	console.error("api id and hash are required");
	process.exit(2);
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
await client.start({
	phoneNumber: () => ask("phone number (international format): "),
	phoneCode: () => ask("code Telegram sent you: "),
	password: () => ask("two-step verification password: "),
	onError: e => console.error(e)
});
console.log(`\nsigned in. Add this line to .env on the server:\n\nTG_SESSION=${client.session.save()}\n`);
await client.disconnect();
rl.close();
process.exit(0);
