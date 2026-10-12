import { State } from "./types";

function parseUrl(): Partial<{ page: string, tag: string, search: string, approved: string }> {
	const hash = window.location.hash.slice(1);

	const entries = hash
		.split(";")
		.filter(e => e.trim().length > 0)
		.map(entry => {
			const [k, v] = entry.split("=");
			return [
				decodeURIComponent(k),
				decodeURIComponent(v)
			];
		});

	return Object.fromEntries(entries);
}

/** `replace` rewrites the current history entry instead of adding one. */
export function updateURL(state: State, replace = false) {
	const url = new URL(window.location.toString());
	url.hash = [
		["page", state.page.pager.page],
		["tag", state.search],
		["approved", state.search !== null && state.approvedOnly ? 1 : null]
	]
		.filter(([_, v]) => v)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join(";");

	if (replace) window.history.replaceState({}, "", url);
	else window.history.pushState({}, "", url);
}

/**
 * Reads page, searched tag name and the approved-only flag from the hash.
 * Old links carry "search=<tag id>"; that id is returned for the caller to
 * resolve to a name once the tag list is loaded.
 */
export function hashToState(state: State): number | null {
	const hashParams = parseUrl();
	state.page.pager.page = hashParams.page ? parseInt(hashParams.page) : 0;
	state.approvedOnly = hashParams.approved === "1";
	if (hashParams.tag) {
		state.search = hashParams.tag;
		return null;
	}
	state.search = null;
	const legacyId = hashParams.search ? parseInt(hashParams.search) : NaN;
	return Number.isFinite(legacyId) ? legacyId : null;
}

/** Removes a "suggest=<token>" entry (an admin-issued link) from the hash and returns the token. */
export function takeSuggestToken(): string | null {
	const params = parseUrl() as Record<string, string>;
	const token = params.suggest;
	if (!token) return null;

	delete params.suggest;
	const url = new URL(window.location.toString());
	url.hash = Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join(";");
	window.history.replaceState({}, "", url);
	return token;
}
