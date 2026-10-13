import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export type Result<T, E> = {
	success: true,
	value: T
} | {
	success: false,
	error: E
};

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_PREFIX = "scrypt$";

/** Salted scrypt hash, stored as "scrypt$<salt>$<key>" (hex). */
export async function hashPassword(raw: string) {
	const salt = randomBytes(16);
	const key = await scrypt(raw, salt, KEY_LENGTH) as Buffer;
	return `${SCRYPT_PREFIX}${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Checks a password against a stored hash. Rows written before salting hold a
 * plain SHA-512 hex digest; those still verify and report `legacy` so the
 * caller can re-hash them.
 */
export async function verifyPassword(raw: string, stored: string): Promise<{ ok: boolean, legacy: boolean }> {
	if (stored.startsWith(SCRYPT_PREFIX)) {
		const [salt, key] = stored.slice(SCRYPT_PREFIX.length).split("$");
		const expected = Buffer.from(key ?? "", "hex");
		const actual = await scrypt(raw, Buffer.from(salt ?? "", "hex"), KEY_LENGTH) as Buffer;
		return { ok: expected.length === actual.length && timingSafeEqual(expected, actual), legacy: false };
	}
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(raw)));
	const hex = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
	return { ok: hex === stored, legacy: true };
}
