import { AttachError, attachTag, Post, posts, tags, untag } from "./api";
import { define as defineTabs, RampikeTabs } from "./components/tabs";
import { define as definePages, RampikePagination } from "./components/pagination";
import { State } from "./types";
import { attachDash } from "./dash";
import { attachSuggest, initSuggest, submitSuggestion, suggestionChip } from "./suggest";
import { renderCoverage } from "./coverage";
import { hashToState, takeSuggestToken, updateURL } from "./url";
import { fromTemplateFirst, mudcrack, rampike, Rampike } from "rampike";

const CURSED_TAGS = [ "реклама", "мерчб" ];

defineTabs();
definePages();
document.addEventListener("DOMContentLoaded", main);

async function main() {
	const pager = document.querySelector<RampikePagination>("#rp-pages");
	const state: State = {
		tags: [],
		page: {
			posts: [],
			pager
		},
		search: null,
		query: null,
		loading: false,
		auth: false,
		suggester: null,
		suggesting: false,
		suggestedOnly: false
	};

	attachListeners(state);

	const tagsReady = updateTags(state);
	const legacyId = hashToState(state);
	// A redeemed link changes which suggestions are "mine", so it goes before the first fetch.
	const linkToken = takeSuggestToken();
	if (linkToken) await initSuggest(state, linkToken);
	else initSuggest(state, null);
	if (legacyId !== null) await resolveLegacySearch(state, legacyId, tagsReady);
	loadPage(state, true);

	window.addEventListener("hashchange", async () => {
		const token = takeSuggestToken();
		if (token) await initSuggest(state, token);
		const legacy = hashToState(state);
		if (legacy !== null) await resolveLegacySearch(state, legacy, state.tags.length ? Promise.resolve() : updateTags(state));
		loadPage(state, true);
	});
}

/** Old links search by tag id ("search=211"); map it to the name and rewrite the hash. */
async function resolveLegacySearch(state: State, id: number, tagsReady: Promise<void>) {
	await tagsReady;
	state.search = state.tags.find(t => t.id === id)?.name ?? null;
	updateURL(state, true);
}

function attachListeners(state: State) {
	const tabsMain = document.querySelector<RampikeTabs>("rampike-tabs#rp-tabs-main");
	document.querySelectorAll<HTMLElement>("[data-tab]").forEach(e => {
		e.addEventListener("click", () => tabsMain.tab = e.dataset.tab);
	});
	attachDash(state, {
		reload: firstPage => {
			if (firstPage) state.page.pager.page = 0;
			loadPage(state, !firstPage);
		},
		recalculateCoverage: () => updatePage(state, true),
		tagChanged: (from, to) => {
			// A search for the old name follows the rename, or is dropped with the tag.
			if (state.search === from) {
				state.search = to;
				if (to === null) state.page.pager.page = 0;
			}
			updateTags(state);
			loadPage(state);
		}
	});
	attachSuggest(state, {
		rerender: () => rerenderPosts(),
		refresh: () => updatePage(state),
		refreshTags: () => updateTags(state),
		search: name => pickTag(state, name)
	});

	// The search bar searches picture transcripts; tags are searched on the tags tab.
	const searchBar = document.querySelector<HTMLInputElement>("input#search-bar");
	const searchCall = () => {
		const text = searchBar.value.trim();
		if (!text) return;
		state.query = text;
		state.search = null;
		state.page.pager.page = 0;
		loadPage(state);
	};
	document.querySelector<HTMLElement>("#search-button").addEventListener("click", searchCall);
	searchBar.addEventListener("keydown", e => {
		if (e.key === "Enter") searchCall();
	});
	document.querySelector<HTMLElement>("#search-reset")?.addEventListener("click", () => {
		searchBar.value = "";
		state.page.pager.page = 0;
		state.search = null;
		state.query = null;
		loadPage(state);
	});

	const tagFilter = document.querySelector<HTMLInputElement>("#tag-filter");
	const tagCall = () => {
		const name = tagFilter.value.trim().toLowerCase();
		if (state.tags.some(t => t.name === name)) pickTag(state, name);
	};
	tagFilter.addEventListener("input", () => filterTagButtons(tagFilter.value));
	tagFilter.addEventListener("keydown", e => {
		if (e.key === "Enter") tagCall();
	});
	document.querySelector<HTMLElement>("#tag-filter-button").addEventListener("click", tagCall);

	state.page.pager.addEventListener("pick", (e: CustomEvent) => {
		state.page.pager.page = e.detail.page;
		loadPage(state);
	});
}

async function updateTags(state: State) {
	const t = await tags();
	if (!t) return;

	state.tags = t;

	let list = document.querySelector("datalist#list-tags");
	if (list) list.innerHTML = "";
	else {
		list = mudcrack({
			tagName: "datalist",
			attributes: {
				id: "list-tags"
			}
		});
		document.body.append(list);
	}

	list.append(...t.map(tag => {
		const item = document.createElement("option");
		item.value = tag.name;
		if (tag.count === 0) item.label = "предложенный";
		item.dataset.id = `${tag.id}`;
		item.dataset.count = `${tag.count}`;
		return item;
	}));

	const buttonList = document.querySelector(".tags-list");
	if (!buttonList) return;
	buttonList.innerHTML = "";
	buttonList.append(...t.map(tag => {
		// "name (5)" for approved posts, plus "+2" in the suggestion style for pending ones;
		// names with nothing approved yet get the dashed outline.
		const contents: Element[] = [
			mudcrack({ tagName: "span", contents: tag.count > 0 ? `${tag.name} (${tag.count})` : tag.name })
		];
		if (tag.suggested > 0)
			contents.push(mudcrack({ tagName: "span", className: "tag-pending", contents: `+${tag.suggested}` }));
		const title = tag.count === 0
			? `предложенный тег, ещё не одобрен (${tag.suggested})`
			: tag.suggested > 0 ? `ещё ${tag.suggested} предложено, не одобрено` : "";
		return mudcrack({
			tagName: "button",
			className: tag.count === 0 ? "tag tag-unapproved" : "tag",
			attributes: { ...(title ? { title } : {}), "data-name": tag.name },
			contents,
			events: {
				click: () => pickTag(state, tag.name)
			}
		});
	}));
	filterTagButtons(document.querySelector<HTMLInputElement>("#tag-filter")?.value ?? "");
}

/** Narrows the tag list to names containing the typed text. */
function filterTagButtons(text: string) {
	const needle = text.trim().toLowerCase();
	document.querySelectorAll<HTMLElement>(".tags-list > .tag").forEach(button => {
		button.hidden = needle.length > 0 && !button.dataset.name.includes(needle);
	});
}

/** The reset button shows while a text or a tag is searched. */
function syncSearchControls(state: State) {
	document.querySelector<HTMLElement>("#search-reset").hidden = state.search === null && state.query === null;
}

/**
 * The line above the results: what is being searched and how much was found;
 * a text search credits the transcriber bot (the link in the sidebar).
 */
function renderSearchStatus(state: State, count: number) {
	const status = document.querySelector<HTMLElement>(".search-status");
	if (!status) return;
	status.innerHTML = "";
	status.hidden = state.query === null && state.search === null;
	if (status.hidden) return;

	const found = count === 0 ? "ничего не нашлось" : `найдено постов: ${count}`;
	if (state.query === null) {
		status.append(`тег «${state.search}»: ${found}`);
		return;
	}
	status.append(`${found} · транскрипции от `);
	const credit = document.querySelector<HTMLAnchorElement>("#transcriber-link")?.cloneNode(true) as HTMLAnchorElement | undefined;
	if (credit) {
		credit.removeAttribute("id");
		status.append(credit);
	}
}

function fetchPage(state: State, recalculateCoverage = false) {
	return posts(state.page.pager.page, state.search ?? undefined, {
		query: state.query ?? undefined,
		suggested: state.auth && state.suggestedOnly,
		recalculateCoverage: state.auth && recalculateCoverage
	});
}

type PageResult = NonNullable<Awaited<ReturnType<typeof fetchPage>>>;

/** Applies a fetched page: pager, search bar, and the coverage chart. */
function applyPage(state: State, result: PageResult) {
	state.page.pager.pageCount = Math.ceil(result.count / result.perPage);
	state.page.posts = result.posts;
	document.querySelector<HTMLInputElement>("#search-bar").value = state.query ?? "";
	renderSearchStatus(state, result.count);
	const filtered = state.search !== null || state.query !== null || (state.auth && state.suggestedOnly);
	renderCoverage(result.coverage, filtered ? null : state.page.pager.page, page => {
		// The chart describes the unfiltered list, so a cell leaves any search or filter.
		state.search = null;
		state.query = null;
		if (state.suggestedOnly) {
			state.suggestedOnly = false;
			document.querySelector<HTMLElement>("#dash-suggested")?.removeAttribute("data-active");
		}
		state.page.pager.page = page;
		document.body.scrollIntoView({behavior: "smooth"});
		loadPage(state);
	});
}

async function loadPage(state: State, skipHashChange: boolean = false) {
	state.loading = true;
	syncSearchControls(state);
	const result = await fetchPage(state);
	if (!result) { state.loading = false; return; }
	applyPage(state, result);
	renderList(state, result.posts);
	state.loading = false;
	if (!skipHashChange) updateURL(state);
}

function renderList(state: State, list: Post[]) {
	const container = document.querySelector<HTMLElement>(".post-list")!;
	container.innerHTML = "";
	if (list.length === 0 && state.auth && state.suggestedOnly) {
		container.append(mudcrack({ tagName: "div", className: "post-list-empty", contents: "no pending suggestions" }));
		return;
	}
	container.append(...list.map(p => makePost(state, p)));
}

/**
 * Re-fetches the page and updates cards in place; re-renders the list if the set of posts changed.
 * `recalculateCoverage` (admin) refreshes the shared coverage snapshot on the way.
 */
async function updatePage(state: State, recalculateCoverage = false) {
	state.loading = true;
	syncSearchControls(state);
	const result = await fetchPage(state, recalculateCoverage);
	if (!result) { state.loading = false; return; }

	const cards = Array.from(document.querySelectorAll<Rampike<HTMLElement, Post>>(".post-list > [data-post-id]"));
	const sameList = cards.length === result.posts.length &&
		cards.every((card, i) => card.dataset.postId === result.posts[i].id);
	if (!sameList) {
		// e.g. an approved suggestion dropped the post out of the "suggested only" list
		applyPage(state, result);
		renderList(state, result.posts);
		state.loading = false;
		return;
	}

	applyPage(state, result);
	result.posts.forEach((post, i) => {
		cards[i].rampike.params = post;
		cards[i].rampike.render();
	});
	state.loading = false;
}

/** Re-renders the cards from the data they already have (e.g. after a mode switch). */
function rerenderPosts() {
	document
		.querySelectorAll<Rampike<HTMLElement, Post>>(".post-list > [data-post-id]")
		.forEach(card => card.rampike.render());
}

const ATTACH_ERRORS: Record<AttachError, string> = {
	invalid: "пустой или слишком длинный тег",
	nopost: "пост не найден",
	unauthorized: "сессия истекла, войдите заново",
	network: "не получилось, попробуйте ещё раз"
};

/** Admin: tags the post right away. Returns an error message, or null on success. */
async function submitTag(state: State, post: string, tag: string): Promise<string | null> {
	const result = await attachTag(post, tag);
	if (result.success === false) return ATTACH_ERRORS[result.error];
	updateTags(state);
	updatePage(state);
	return null;
}

function makePost(state: State, post: Post) {
	const postTemplate = document.querySelector<HTMLTemplateElement>("template#t-post")!;
	let adderListenerAttached = false;

	return rampike<HTMLDivElement, Post>(fromTemplateFirst(postTemplate), post, (params, root) => {
		const [image, caption, tags, adder, source] = Array.from(root.children) as [
			HTMLDivElement,
			HTMLDivElement,
			HTMLDivElement,
			HTMLInputElement,
			HTMLAnchorElement
		];
		root.dataset.postId = params.id;
		root.title = params.id;

		image.hidden = params.media.length === 0;
		image.style.setProperty("--media-count", `${params.media.length}`);
		image.innerHTML = "";
		image.append(...params.media.map((_, i) => {
			const e = document.createElement("img");
			e.src = `/r2/${params.id}-${i}`;
			return e;
		}));

		caption.hidden = !params.caption;
		caption.textContent = params.caption;

		tags.innerHTML = "";
		tags.hidden = params.tags.length === 0 && params.suggestions.length === 0;
		tags.append(...params.tags.map(({ name, id }) => {
			const e = mudcrack({
				tagName: "div",
				className: "tag",
				contents: name,
				events: {
					"click": () => pickTag(state, name),
					// Admin: right click removes the tag from this post.
					"contextmenu": e => {
						if (!state.auth) return;
						e.preventDefault();
						untag(params.id, id).then(() => {
							updateTags(state);
							updatePage(state);
						});
					}
				},
			});
			if (CURSED_TAGS.includes(name)) e.dataset.cursed = "true";
			return e;
		}));

		tags.append(...params.suggestions.map(s => suggestionChip(state, params, s)));

		adder.hidden = !state.auth && !state.suggesting;
		adder.placeholder = state.auth ? "add tag" : "предложить тег";
		if (!adderListenerAttached) {
			adder.addEventListener("input", () => adder.setCustomValidity(""));
			adder.addEventListener("keydown", async e => {
				if (e.key !== "Enter") return;
				const value = adder.value.trim();
				if (value.length === 0) return;
				adder.disabled = true;
				const error = state.auth
					? await submitTag(state, params.id, value)
					: await submitSuggestion(state, params.id, value);
				adder.disabled = false;
				if (error) {
					adder.setCustomValidity(error);
					adder.reportValidity();
				} else {
					adder.value = "";
				}
			});
			adderListenerAttached = true;
		}

		source.href = params.source;
		source.textContent = params.source;
	});
}

/** Lists the posts with a tag; this replaces a text search. */
function pickTag(state: State, tag: string) {
	state.search = tag;
	state.query = null;
	state.page.pager.page = 0;
	document.body.scrollIntoView({behavior: "smooth"});
	document.querySelector<HTMLButtonElement>(`[data-for="rp-tabs-main"][data-tab="posts"]`)?.click();
	loadPage(state);
}
