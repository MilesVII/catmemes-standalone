export type Result<T, E> = {
	success: true,
	value: T
} | {
	success: false,
	error: E
};

export async function password(raw: string) {
	const text = new TextEncoder().encode(raw);

	const digest = await crypto.subtle.digest({ name: "SHA-512" }, text);

	return [...new Uint8Array(digest)]
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function nothrow<T>(cb: () => Promise<T>): Promise<Result<T, string>> {
	try {
		return { success: true, value: await cb() };
	} catch(e) {
		console.error(e);
		return { success: false, error: (e as Error)?.name ?? "unknown" }
	}
}
