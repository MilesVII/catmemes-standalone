import { State } from "./types";

function parseUrl(): Partial<{ page: string, search: string }> {
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

export function updateURL(state: State) {
	const url = new URL(window.location.toString());
	url.hash = [
		["page", state.page.pager.page],
		["search", state.search]
	]
		.filter(([_, v]) => v)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join(";");
	
	window.history.pushState({}, "", url);
}

export function hashToState(state: State) {
	const hashParams = parseUrl();
	state.page.pager.page = hashParams.page ? parseInt(hashParams.page) : 0;
	state.search = hashParams.search ? parseInt(hashParams.search) : null;
}