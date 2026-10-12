import { mudcrack } from "rampike";
import {
	Post,
	Suggestion,
	SuggestError,
	suggestAdd,
	suggestApprove,
	suggestRedeem,
	suggestReject,
	suggestRemove,
	suggestStatus,
	suggestToken,
	suggestVote
} from "./api";
import { State } from "./types";

type Hooks = {
	/** Re-render the current cards without fetching (mode changes). */
	rerender: () => void,
	/** Re-fetch the current page (data changes). */
	refresh: () => void,
	/** Re-fetch tags after a suggestion became a real tag. */
	refreshTags: () => void,
	/** Search posts by a tag name. */
	search: (name: string) => void
};

const ERRORS: Record<SuggestError | "network", string> = {
	nosuggester: "токен истёк",
	invalid: "пустой или слишком длинный тег",
	nopost: "пост не найден",
	exists: "такой тег уже есть или предложен",
	limit: "лимит предложений для этого токена исчерпан",
	notfound: "предложение уже удалено",
	own: "нельзя голосовать за своё предложение",
	network: "не получилось, попробуйте ещё раз"
};

function formatDuration(ms: number) {
	const minutes = Math.ceil(ms / 60_000);
	const h = Math.floor(minutes / 60), m = minutes % 60;
	return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}
const formatDate = (ms: number) =>
	new Date(ms).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let hooks: Hooks;
let toggleButton: HTMLButtonElement;
let info: HTMLElement;

/** Sidebar button that requests a suggester token and toggles suggestion mode. */
export function attachSuggest(state: State, h: Hooks) {
	hooks = h;
	toggleButton = document.querySelector<HTMLButtonElement>("#suggest-toggle")!;
	info = document.querySelector<HTMLElement>("#suggest-info")!;

	toggleButton.addEventListener("click", async () => {
		if (state.suggesting) {
			setMode(state, false);
			return;
		}
		if (state.suggester && state.suggester.expiry > Date.now()) {
			setMode(state, true);
			return;
		}

		toggleButton.disabled = true;
		const result = await suggestToken();
		toggleButton.disabled = false;
		if (!result) {
			showInfo(ERRORS.network);
		} else if (result.success) {
			state.suggester = { expiry: result.value.expiry };
			setMode(state, true);
			// The token cookie changes which suggestions count as "mine".
			hooks.refresh();
		} else {
			showInfo(`сейчас токенов нет, новый можно будет получить через ${formatDuration(result.error.cooldown)}`);
		}
	});
}

/** Redeems an admin-issued link (if any) and loads the token status. */
export async function initSuggest(state: State, linkToken: string | null) {
	if (linkToken) {
		const redeemed = await suggestRedeem(linkToken);
		if (redeemed?.success) {
			state.suggester = { expiry: redeemed.value.expiry };
			setMode(state, true);
			return true;
		}
		showInfo("ссылка для предложений недействительна или истекла");
	}
	const status = await suggestStatus();
	state.suggester = status?.active ?? null;
	syncControls(state);
	return false;
}

function setMode(state: State, suggesting: boolean) {
	state.suggesting = suggesting;
	syncControls(state);
	hooks.rerender();
}

function showInfo(text: string) {
	info.textContent = text;
	info.hidden = false;
}

function syncControls(state: State) {
	toggleButton.textContent = state.suggesting ? "закончить" : "предложить теги";
	toggleButton.toggleAttribute("data-active", state.suggesting);
	if (state.suggester)
		showInfo(`предлагать теги можно до ${formatDate(state.suggester.expiry)}`);
	else if (!state.suggesting)
		info.hidden = true;
}

/** Called when the server says the token is gone. */
function expire(state: State) {
	state.suggester = null;
	state.suggesting = false;
	syncControls(state);
	showInfo(ERRORS.nosuggester);
	hooks.rerender();
}

/** Submits the post card's tag input as a suggestion. Returns an error message or null. */
export async function submitSuggestion(state: State, post: string, tag: string): Promise<string | null> {
	const result = await suggestAdd(post, tag);
	if (result.success) {
		hooks.refresh();
		hooks.refreshTags();
		return null;
	}
	if (result.error === "nosuggester") expire(state);
	return ERRORS[result.error];
}

/** A suggested tag on a post card, with controls depending on who is looking. */
export function suggestionChip(state: State, post: Post, suggestion: Suggestion) {
	const chip = mudcrack({
		tagName: "div",
		className: "tag suggested",
		attributes: { title: "предложенный тег" }
	});

	const run = async (action: () => Promise<{ success: boolean, error?: SuggestError | "network" }>, tagsChanged = false) => {
		chip.querySelectorAll("button").forEach(b => b.disabled = true);
		const result = await action();
		if (!result.success && result.error === "nosuggester") expire(state);
		else if (!result.success && result.error) console.warn(ERRORS[result.error]);
		if (tagsChanged && result.success) hooks.refreshTags();
		hooks.refresh();
	};
	const button = (label: string, title: string, onClick: () => void, active = false) =>
		mudcrack({
			tagName: "button",
			className: "suggested-button",
			contents: label,
			attributes: active ? { title, "data-active": "" } : { title },
			events: { click: onClick }
		});

	const controls: HTMLElement[] = [];
	if (state.auth) {
		controls.push(
			mudcrack({
				tagName: "span",
				className: "suggested-score",
				contents: `+${suggestion.up ?? 0} −${suggestion.down ?? 0}`
			}),
			button("✓", "принять", () => run(() => suggestApprove(suggestion.id), true)),
			button("✕", "отклонить", () => run(() => suggestReject(suggestion.id), true))
		);
	} else if (suggestion.mine) {
		controls.push(button("✕", "удалить своё предложение", () => run(() => suggestRemove(suggestion.id), true)));
	} else {
		const vote = (value: -1 | 1) => () =>
			run(() => suggestVote(suggestion.id, suggestion.myVote === value ? 0 : value));
		controls.push(
			button("−", "против", vote(-1), suggestion.myVote === -1),
			button("+", "за", vote(1), suggestion.myVote === 1)
		);
	}

	chip.append(
		mudcrack({
			tagName: "span",
			className: "suggested-name",
			contents: suggestion.name,
			events: { click: () => hooks.search(suggestion.name) }
		}),
		...controls
	);
	chip.dataset.post = post.id;
	return chip;
}
