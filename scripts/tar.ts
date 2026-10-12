/**
 * Minimal streaming ustar writer/reader: enough for backups of one database
 * file plus a flat media directory, and readable by any `tar` (`tar -tzf`).
 */
import { once } from "node:events";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

const BLOCK = 512;

export type PackEntry = {
	name: string,
	size: number,
	/** ms since epoch */
	mtime: number,
	content: () => AsyncIterable<Buffer> | Iterable<Buffer>,
	/** Called when the content ended before `size` bytes; the rest is zero-filled. */
	onShort?: (missing: number) => void
};

export type TarEntry = {
	name: string,
	size: number,
	/** "0" regular file, "5" directory, others are skipped by callers */
	type: string
};

/** What to do with an entry's bytes; `done` runs after the sink has finished. */
export type EntryHandler = { sink: Writable, done?: () => Promise<void> | void } | null;

function octal(value: number, length: number) {
	const digits = value.toString(8);
	if (digits.length > length - 1) throw new Error(`value ${value} does not fit a ${length}-byte tar field`);
	return digits.padStart(length - 1, "0") + "\0";
}

/** ustar keeps up to 100 bytes in "name" and 155 more in "prefix", split at a slash. */
function splitName(name: string): [string, string] {
	if (Buffer.byteLength(name) <= 100) return [name, ""];
	for (let i = name.lastIndexOf("/"); i > 0; i = name.lastIndexOf("/", i - 1)) {
		const prefix = name.slice(0, i), rest = name.slice(i + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return [rest, prefix];
	}
	throw new Error(`path too long for tar: ${name}`);
}

function checksum(header: Buffer) {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
	return sum;
}

function header(name: string, size: number, mtime: number) {
	const h = Buffer.alloc(BLOCK);
	const [base, prefix] = splitName(name);
	h.write(base, 0, 100, "utf8");
	h.write(octal(0o644, 8), 100, "ascii");
	h.write(octal(0, 8), 108, "ascii");
	h.write(octal(0, 8), 116, "ascii");
	h.write(octal(size, 12), 124, "ascii");
	h.write(octal(Math.floor(mtime / 1000), 12), 136, "ascii");
	h.write("0", 156, "ascii");
	h.write("ustar\0", 257, "ascii");
	h.write("00", 263, "ascii");
	h.write(prefix, 345, 155, "utf8");
	h.write(octal(checksum(h), 7) + " ", 148, "ascii");
	return h;
}

/** Yields the archive as buffers; pair with Readable.from() and a gzip stream. */
export async function* pack(entries: AsyncIterable<PackEntry> | Iterable<PackEntry>) {
	for await (const entry of entries) {
		yield header(entry.name, entry.size, entry.mtime);
		let written = 0;
		for await (const chunk of entry.content()) {
			const part = written + chunk.length > entry.size ? chunk.subarray(0, entry.size - written) : chunk;
			written += part.length;
			if (part.length > 0) yield part;
			if (written >= entry.size) break;
		}
		if (written < entry.size) {
			entry.onShort?.(entry.size - written);
			yield Buffer.alloc(entry.size - written);
		}
		const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
		if (padding > 0) yield Buffer.alloc(padding);
	}
	yield Buffer.alloc(BLOCK * 2);
}

function field(h: Buffer, offset: number, length: number) {
	const raw = h.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function parseHeader(h: Buffer): TarEntry {
	const stored = parseInt(field(h, 148, 8).trim(), 8);
	if (stored !== checksum(h)) throw new Error("not a tar archive, or it is corrupted (bad header checksum)");
	const name = field(h, 0, 100);
	const prefix = field(h, 257, 6) === "ustar" ? field(h, 345, 155) : "";
	const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
	return {
		name: (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ""),
		size: parseInt(field(h, 124, 12).trim() || "0", 8),
		type
	};
}

/**
 * Streams through an archive, asking `onEntry` where each entry's bytes go.
 * Returning null skips the entry. Back-pressure is respected.
 */
export async function extract(source: AsyncIterable<Buffer>, onEntry: (entry: TarEntry) => Promise<EntryHandler> | EntryHandler) {
	let buffer: Buffer = Buffer.alloc(0);
	let body: { handler: EntryHandler, remaining: number, padding: number } | null = null;
	let zeroBlocks = 0;

	const closeEntry = async () => {
		if (body?.handler) {
			body.handler.sink.end();
			await finished(body.handler.sink);
			await body.handler.done?.();
		}
		body = null;
	};

	for await (const chunk of source) {
		buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
		while (true) {
			if (body === null) {
				if (buffer.length < BLOCK) break;
				const h = buffer.subarray(0, BLOCK);
				buffer = buffer.subarray(BLOCK);
				if (h.every(b => b === 0)) {
					if (++zeroBlocks === 2) return;
					continue;
				}
				zeroBlocks = 0;
				const entry = parseHeader(h);
				body = {
					handler: entry.type === "0" ? await onEntry(entry) : null,
					remaining: entry.size,
					padding: (BLOCK - (entry.size % BLOCK)) % BLOCK
				};
			}
			if (body.remaining > 0) {
				if (buffer.length === 0) break;
				const part = buffer.subarray(0, Math.min(buffer.length, body.remaining));
				buffer = buffer.subarray(part.length);
				body.remaining -= part.length;
				const sink = body.handler?.sink;
				if (sink && !sink.write(part)) await once(sink, "drain");
				continue;
			}
			if (body.padding > 0) {
				const skip = Math.min(buffer.length, body.padding);
				buffer = buffer.subarray(skip);
				body.padding -= skip;
				if (body.padding > 0) break;
			}
			await closeEntry();
		}
	}
	throw new Error("archive ended unexpectedly (truncated?)");
}
