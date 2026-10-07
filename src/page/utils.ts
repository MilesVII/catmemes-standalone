
export type Result<T, E> = {
	success: true,
	value: T
} | {
	success: false,
	error: E
};

export async function nothrow<T>(cb: () => Promise<T>): Promise<Result<T, string>> {
	try {
		return { success: true, value: await cb() };
	} catch(e) {
		console.error(e);
		return { success: false, error: (e as Error)?.name ?? "unknown" }
	}
}
