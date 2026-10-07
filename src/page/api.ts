import { nothrow, Result } from "./utils";

async function api(
	endpoint: string,
	payload: any = {}
): Promise<
	Result<any, any>
> {
	const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(payload) });
	if (response.ok) {
		const result = await nothrow(async () => await response.json());
		if (!result.success) return result;

		if (result.value.clearance !== "ok")
			return {
				success: false as const,
				error: `unauthorized: ${result.value.clearance}`
			};
		return { success: true, value: result.value.result }
	} else {
		console.error(response);
		return { success: false as const, error: response };
	}
}

export type Tag = {
	id: number,
	name: string,
	count: number
}
export async function tags() {
	const result = await api("/api/tags");
	if (result.success)
		return result.value as Tag[];
	else
		return null;
}

export type Post = {
	caption: string,
	id: string,
	media: string[],
	source: string,
	tags: {
		id: number,
		name: string
	}[]
}
export async function posts(page: number, search?: number) {
	const result = await api("/api/posts", { page, search });
	if (result.success) {
		const posts: Post[] = result.value.posts.map((raw: any) => ({
			caption: raw.caption,
			id: raw.id,
			media: raw.media.split("\n"),
			source: raw.source,
			tags: JSON.parse(raw.tags)
				.map((t: any) => ({
					id: t.tagId,
					name: t.tagName
				}))
				.filter((t: any) => t.id !== null)
		}));
		return { count: result.value.count, posts, perPage: result.value.perPage };
	} else
		return null;
}

export type Sessions = {
	id: number,
	info: string
}[];
export async function vibecheck() {
	const result = await api("/api/user/vibecheck");
	return result.success ? result.value as Sessions : null;
}

export async function signin(login: string, password: string) {
	const result = await api("/api/user/signin", { login, password, info: window.navigator.userAgent });
	return result.success ? result.value.value.sessions : null; // TODO: wtf
}

export async function signout(id: number) {
	return await api("/api/user/signoff", { session: id });
}

export async function changePassword(newPassword: string) {
	return await api("/api/user/change", { newPassword });
}

export async function attachTag(post: string, tag: string) {
	return await api("/api/post/attach", { post, tag });
}

export async function untag(post: string, tag: number) {
	return await api("/api/post/untag", { post, tag });
}
