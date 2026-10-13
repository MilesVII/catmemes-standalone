import { nothrow, Result } from "./utils";

/** A failure of the transport or of the session, as opposed to one the route reports itself. */
type CallError = "unauthorized" | "network";

async function api(
	endpoint: string,
	payload: any = {}
): Promise<
	Result<any, CallError>
> {
	const sent = await nothrow(() => fetch(endpoint, { method: "POST", body: JSON.stringify(payload) }));
	if (!sent.success) return { success: false, error: "network" }; // offline, DNS, connection reset
	const response = sent.value;
	if (!response.ok) {
		console.error(response);
		return { success: false, error: response.status === 401 ? "unauthorized" : "network" };
	}
	const result = await nothrow(async () => await response.json());
	if (!result.success) return { success: false, error: "network" };
	if (result.value.clearance !== "ok") return { success: false, error: "unauthorized" };
	return { success: true, value: result.value.result };
}

/** For routes that answer with their own Result: unwraps it, mapping call failures to the same shape. */
async function call<T, E>(endpoint: string, payload: any = {}): Promise<Result<T, E | CallError>> {
	const result = await api(endpoint, payload);
	return result.success ? result.value : result;
}

export type Tag = {
	/** null for names that so far exist only as suggestions */
	id: number | null,
	name: string,
	/** posts with the approved tag */
	count: number,
	/** posts where the name is a pending suggestion */
	suggested: number
}
export async function tags() {
	const result = await api("/api/tags");
	return result.success ? result.value as Tag[] : null;
}

export type Suggestion = {
	id: number,
	name: string,
	/** Suggested with this browser's token. */
	mine: boolean,
	/** This visitor's vote: -1, 0 or 1. */
	myVote: number,
	/** Tallies, present for admins only. */
	up?: number,
	down?: number
}
export type Post = {
	caption: string,
	id: string,
	media: string[],
	source: string,
	tags: {
		id: number,
		name: string
	}[],
	suggestions: Suggestion[]
}
export type PostsOptions = {
	/** Admin: only posts with pending suggestions. */
	suggested?: boolean,
	/** Admin: recompute the tag coverage snapshot. */
	recalculateCoverage?: boolean
}
/** Tag coverage of the whole, unfiltered list; shared by everyone, recomputed on admin request. */
export type CoverageSnapshot = {
	computedAt: number,
	perPage: number,
	count: number,
	/** posts with at least one approved tag, per page */
	tagged: number[]
}
/** `search` is a tag name; posts where it is a pending suggestion match too. */
export async function posts(page: number, search?: string, options: PostsOptions = {}) {
	const result = await api("/api/posts", { page, search, ...options });
	if (!result.success) return null;

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
			.filter((t: any) => t.id !== null),
		suggestions: raw.suggestions ?? []
	}));
	return {
		count: result.value.count as number,
		posts,
		perPage: result.value.perPage as number,
		coverage: (result.value.coverage ?? null) as CoverageSnapshot | null
	};
}

export type Sessions = {
	id: number,
	info: string
}[];
export async function vibecheck() {
	const result = await api("/api/user/vibecheck");
	return result.success ? result.value as Sessions : null;
}

/** The session cookie is set by the server; the answer is the session list. */
export async function signin(login: string, password: string) {
	const result = await api("/api/user/signin", { login, password, info: window.navigator.userAgent });
	return result.success ? result.value as Sessions : null;
}

export async function signout(id: number) {
	return await api("/api/user/signoff", { session: id });
}

export async function changePassword(newPassword: string) {
	return await api("/api/user/change", { newPassword });
}

export type AttachError = "invalid" | "nopost" | CallError;
export const attachTag = (post: string, tag: string) =>
	call<true, "invalid" | "nopost">("/api/post/attach", { post, tag });

export async function untag(post: string, tag: number) {
	return await api("/api/post/untag", { post, tag });
}

export type TagError = "invalid" | "notfound" | "exists" | CallError;
export type TagChange = {
	/** posts affected */
	posts: number,
	/** pending suggestions renamed or dropped */
	suggestions: number
};
/** Admin: renames the tag; with `merge`, an existing tag of that name absorbs it. */
export const renameTag = (tag: number, name: string, merge = false) =>
	call<TagChange & { merged: boolean }, "invalid" | "notfound" | "exists">("/api/tag/rename", { tag, name, merge });
/** Admin: removes the tag from every post. */
export const deleteTag = (tag: number) =>
	call<TagChange, "notfound">("/api/tag/delete", { tag });

export type SuggestStatus = {
	active: { expiry: number } | null,
	/** Milliseconds until a new token can be requested. */
	cooldown: number
};
export async function suggestStatus() {
	const result = await api("/api/suggest/status");
	return result.success ? result.value as SuggestStatus : null;
}

export async function suggestToken() {
	const result = await api("/api/suggest/token");
	return result.success
		? result.value as Result<{ expiry: number }, { cooldown: number }>
		: null;
}

export async function suggestRedeem(token: string) {
	const result = await api("/api/suggest/redeem", { token });
	return result.success ? result.value as Result<{ expiry: number }, string> : null;
}

export async function suggestIssue() {
	const result = await api("/api/suggest/issue");
	return result.success ? result.value as { token: string, expiry: number } : null;
}

export type SuggestError = "nosuggester" | "invalid" | "nopost" | "exists" | "limit" | "notfound" | "own";
type SuggestResult<T> = Result<T, SuggestError | "network">;
async function suggestCall<T>(endpoint: string, payload: any): Promise<SuggestResult<T>> {
	const result = await api(endpoint, payload);
	return result.success ? result.value : { success: false, error: "network" };
}

export const suggestAdd = (post: string, tag: string) =>
	suggestCall<{ id: number }>("/api/suggest/add", { post, tag });
export const suggestRemove = (suggestion: number) =>
	suggestCall<true>("/api/suggest/remove", { suggestion });
export const suggestVote = (suggestion: number, value: -1 | 0 | 1) =>
	suggestCall<true>("/api/suggest/vote", { suggestion, value });
export const suggestApprove = (suggestion: number) =>
	suggestCall<true>("/api/suggest/approve", { suggestion });
export const suggestReject = (suggestion: number) =>
	suggestCall<true>("/api/suggest/reject", { suggestion });
