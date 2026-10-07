import { attachTag, Post, posts, tags, untag } from "./api";
import { define as defineTabs, RampikeTabs } from "./components/tabs";
import { define as definePages, RampikePagination } from "./components/pagination";
import { State } from "./types";
import { attachDash } from "./dash";
import { hashToState, updateURL } from "./url";
import { fromTemplateFirst, mudcrack, rampike, Rampike } from "rampike";

start();

async function start() {
	components();
	document.addEventListener("DOMContentLoaded", main);
}

function components() {
	defineTabs();
	definePages();
}

async function main() {
	const pager = document.querySelector<RampikePagination>("#rp-pages");
	const state: State = {
		tags: [],
		page: {
			posts: [],
			pager
		},
		search: null,
		loading: false,
		auth: false
	};

	attachListeners(state);

	updateTags(state);
	hashToState(state);
	loadPage(state, true);

	window.addEventListener("hashchange", () => {
		hashToState(state);
		loadPage(state, true);
	});
}

function attachListeners(state: State) {
	const tabsMain = document.querySelector<RampikeTabs>("rampike-tabs#rp-tabs-main");
	// const tabsSide = document.querySelector<RampikeTabs>("rampike-tabs#rp-tabs-side");
	document.querySelectorAll<HTMLElement>("[data-tab]").forEach(e => {
		// const target = e.dataset.for === "rp-tabs-main" ? tabsMain : tabsSide;
		const target = tabsMain;
		e.addEventListener("click", () => target.tab = e.dataset.tab);
	});
	attachDash(state, () => loadPage(state, true));

	const searchBar = document.querySelector<HTMLInputElement>("input#search-bar");
	const searchButton = document.querySelector<HTMLElement>("#search-button");
	const searchCall = () => {
		const term = searchBar.value.trim().toLowerCase();
		const tag = state.tags.find(t => t.name === term);
		if (!tag) return;
		pickTag(state, tag.id);
	};
	searchButton.addEventListener("click", searchCall);
	searchBar.addEventListener("keydown", e => {
		if (e.key !== "Enter") return;
		searchCall();
	});
	document.querySelector<HTMLElement>("#search-reset")?.addEventListener("click", () => {
		searchBar.value = "";
		state.page.pager.page = 0;
		state.search = null;
		loadPage(state);
	});

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
		item.dataset.id = `${tag.id}`;
		item.dataset.count = `${tag.count}`;
		return item;
	}));

	const buttonList = document.querySelector(".tags-list");
	const searchBar = document.querySelector<HTMLInputElement>("#search-bar");
	if (!buttonList || !searchBar) return;
	buttonList.innerHTML = "";
	buttonList.append(...t.map(tag => 
		mudcrack({
			tagName: "button",
			className: "tag",
			contents: `${tag.name} (${tag.count})`,
			events: {
				click: () => {
					searchBar.value = tag.name;
					pickTag(state, tag.id);
				}
			}
		})
	));
}

async function loadPage(state: State, skipHashChange: boolean = false) {
	state.loading = true;
	document.querySelector<HTMLElement>("#search-reset").hidden = state.search === null;
	const result = await posts(state.page.pager.page, state.search ?? undefined);
	state.page.pager.pageCount = Math.ceil(result.count / result.perPage);
	state.page.posts = result.posts;
	const container = document.querySelector<HTMLElement>(".post-list")!;
	container.innerHTML = "";
	container.append(...Array.from(result.posts).map(p => makePost(state, p)));
	state.loading = false;
	if (state.search !== null) {
		const searchBar = document.querySelector<HTMLInputElement>("#search-bar");
		const currentTag = state.tags.find(({id}) => id === state.search);
		if (currentTag) searchBar.value = currentTag.name;
	}
	if (!skipHashChange) updateURL(state);
}
async function updatePage(state: State) {
	state.loading = true;
	document.querySelector<HTMLElement>("#search-reset").hidden = state.search === null;
	const result = await posts(state.page.pager.page, state.search ?? undefined);
	state.page.pager.pageCount = Math.ceil(result.count / result.perPage);
	state.page.posts = result.posts;
	let reloadFlag = false;
	result.posts.forEach(post => {
		const target = document.querySelector<Rampike<HTMLElement, Post>>(`[data-post-id="${post.id}"]`);
		if (!target) {
			console.error("can't find post card for ", post.id);
			reloadFlag = true;
			return;
		}
		target.rampike.params = post;
		target.rampike.render();
	})
	state.loading = false;
	if (state.search !== null) {
		const searchBar = document.querySelector<HTMLInputElement>("#search-bar");
		const currentTag = state.tags.find(({id}) => id === state.search);
		if (currentTag) searchBar.value = currentTag.name;
	}
	if (reloadFlag) window.location.reload();
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
		tags.hidden = params.tags.length === 0;
		tags.append(...params.tags.map(({ name, id }) =>
			mudcrack({
				tagName: "div",
				className: "tag",
				contents: name,
				events: {
					"click": () => pickTag(state, id),
					"mousedown": e => {
						if (e.button !== 2 || !state.auth) return true;
						e.preventDefault();
						untag(params.id, id).then(() => {
							updateTags(state);
							updatePage(state);
						});
						return false;
					}
				}
			})
		));

		adder.hidden = !state.auth;
		if (!adderListenerAttached) {
			adder.addEventListener("keydown", async e => {
				if (e.key !== "Enter") return;
				const value = adder.value.trim();
				if (value.length === 0) return;
				adder.disabled = true;
				await attachTag(params.id, value);
				adder.disabled = false;
				updateTags(state);
				updatePage(state);
			});
			adderListenerAttached = true;
		}

		source.href = params.source;
		source.textContent = params.source;
	});
}

function pickTag(state: State, tag: number) {
	state.search = tag;
	state.page.pager.page = 0;
	document.body.scrollIntoView({behavior: "smooth"});
	document.querySelector<HTMLButtonElement>(`[data-for="rp-tabs-main"][data-tab="posts"]`)?.click();
	loadPage(state);
}
