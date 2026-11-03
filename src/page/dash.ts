import { mudcrack } from "rampike";
import { changePassword, deleteTag, renameTag, Sessions, signin, signout, suggestIssue, TagError, vibecheck } from "./api";
import { RampikeTabs } from "./components/tabs";
import { State } from "./types";

type DashHooks = {
	/** `reload(true)` goes back to page 1, `reload(false)` re-fetches the current page. */
	reload: (firstPage: boolean) => void,
	/** Recomputes the tag coverage snapshot shown to everyone. */
	recalculateCoverage: () => Promise<void>,
	/** A tag was renamed (`to` is the new name) or removed everywhere (`to` is null). */
	tagChanged: (from: string, to: string | null) => void
};

const TAG_ERRORS: Record<TagError, string> = {
	invalid: "пустое или слишком длинное имя",
	notfound: "нет такого тега",
	exists: "тег с таким именем уже есть",
	unauthorized: "сессия истекла, войдите заново",
	network: "не получилось, попробуйте ещё раз"
};

export function attachDash(state: State, { reload, recalculateCoverage, tagChanged }: DashHooks) {
	const dashTabs =        document.querySelector<RampikeTabs>("#rp-tabs-dash")
	const vibecheckButton = document.querySelector<HTMLButtonElement>("#dash-check");
	const loginField =      document.querySelector<HTMLInputElement>("#dash-login");
	const passwordField =   document.querySelector<HTMLInputElement>("#dash-pass");
	const signinForm =      document.querySelector<HTMLFormElement>("#dash-signin-form");
	const signinButton =    document.querySelector<HTMLButtonElement>("#dash-signin");
	const sessionList =     document.querySelector<HTMLDivElement>(".dash-session-list");
	const changeField =     document.querySelector<HTMLInputElement>("#dash-change-field");
	const changeForm =      document.querySelector<HTMLFormElement>("#dash-change-form");
	const suggestedButton = document.querySelector<HTMLButtonElement>("#dash-suggested");
	const coverageButton =  document.querySelector<HTMLButtonElement>("#dash-coverage");
	const issueButton =     document.querySelector<HTMLButtonElement>("#dash-issue");
	const issueLink =       document.querySelector<HTMLInputElement>("#dash-issue-link");
	const tagField =        document.querySelector<HTMLInputElement>("#dash-tag");
	const tagNewField =     document.querySelector<HTMLInputElement>("#dash-tag-new");
	const tagRenameButton = document.querySelector<HTMLButtonElement>("#dash-tag-rename");
	const tagDeleteButton = document.querySelector<HTMLButtonElement>("#dash-tag-delete");
	const tagInfo =         document.querySelector<HTMLElement>("#dash-tag-info");

	function fillSessionList(sessions: Sessions) {
		sessionList.innerHTML = "";
		sessionList.append(...sessions.map(({id, info}) =>
			mudcrack({
				tagName: "button",
				className: "wide tag",
				contents: info,
				events: {
					"click": (_, el) => {
						signout(id);
						el.remove();
					}
				}
			})
		));
	}
	function authorized(sessions: Sessions) {
		fillSessionList(sessions);
		dashTabs.tab = "admin";
		state.auth = true;
		reload(false);
	}
	vibecheckButton.addEventListener("click", async () => {
		const vibe = await vibecheck();
		if (vibe) authorized(vibe);
		else dashTabs.tab = "signin";
	});
	// Real forms, so Enter submits and password managers recognise the fields.
	signinForm.addEventListener("submit", async e => {
		e.preventDefault();
		signinButton.disabled = true;
		const result = await signin(loginField.value, passwordField.value);
		signinButton.disabled = false;
		if (!result) return;
		passwordField.value = "";
		authorized(result);
	});

	changeForm.addEventListener("submit", e => {
		e.preventDefault();
		changePassword(changeField.value).then(() => dashTabs.tab = "signin");
		changeField.value = "";
		state.auth = false;
		state.suggestedOnly = false;
		suggestedButton.removeAttribute("data-active");
		reload(false);
	});

	suggestedButton.addEventListener("click", () => {
		state.suggestedOnly = !state.suggestedOnly;
		suggestedButton.toggleAttribute("data-active", state.suggestedOnly);
		reload(true);
	});
	coverageButton.addEventListener("click", async () => {
		coverageButton.disabled = true;
		await recalculateCoverage();
		coverageButton.disabled = false;
	});
	issueButton.addEventListener("click", async () => {
		issueButton.disabled = true;
		const issued = await suggestIssue();
		issueButton.disabled = false;
		if (!issued) return;

		const url = new URL(window.location.toString());
		url.hash = `suggest=${encodeURIComponent(issued.token)}`;
		issueLink.value = url.toString();
		issueLink.hidden = false;
		issueLink.select();
		navigator.clipboard?.writeText(issueLink.value).catch(() => {});
	});

	// ---- tag management: rename (or merge) and delete everywhere

	const showTagInfo = (text: string) => {
		tagInfo.textContent = text;
		tagInfo.hidden = false;
	};
	/** The approved tag typed into the field; names that are only suggested have no id to act on. */
	const pickedTag = () => {
		const name = tagField.value.trim().toLowerCase();
		const tag = state.tags.find(t => t.name === name);
		if (!tag || tag.id === null) {
			showTagInfo(TAG_ERRORS.notfound);
			return null;
		}
		return tag as { id: number, name: string, count: number };
	};
	const busy = (on: boolean) => {
		tagRenameButton.disabled = on;
		tagDeleteButton.disabled = on;
	};

	tagRenameButton.addEventListener("click", async () => {
		const tag = pickedTag();
		if (!tag) return;
		const name = tagNewField.value.trim().toLowerCase();
		if (!name) { showTagInfo(TAG_ERRORS.invalid); return; }
		if (name === tag.name) { showTagInfo("имя не изменилось"); return; }

		const target = state.tags.find(t => t.name === name && t.id !== null);
		const merge = target !== undefined;
		if (merge && !window.confirm(`тег «${name}» уже есть (${target.count}). объединить «${tag.name}» (${tag.count}) с ним?`)) return;

		busy(true);
		const result = await renameTag(tag.id, name, merge);
		busy(false);
		if (result.success === false) { showTagInfo(TAG_ERRORS[result.error]); return; }

		showTagInfo(`${result.value.merged ? "объединено" : "переименовано"}: «${tag.name}» → «${name}», постов: ${result.value.posts}` +
			(result.value.suggestions > 0 ? `, предложений: ${result.value.suggestions}` : ""));
		tagField.value = name;
		tagNewField.value = "";
		tagChanged(tag.name, name);
	});

	tagDeleteButton.addEventListener("click", async () => {
		const tag = pickedTag();
		if (!tag) return;
		if (!window.confirm(`удалить тег «${tag.name}» со всех постов (${tag.count})? это нельзя отменить`)) return;

		busy(true);
		const result = await deleteTag(tag.id);
		busy(false);
		if (result.success === false) { showTagInfo(TAG_ERRORS[result.error]); return; }

		showTagInfo(`удалено: «${tag.name}», постов: ${result.value.posts}` +
			(result.value.suggestions > 0 ? `, предложений: ${result.value.suggestions}` : ""));
		tagField.value = "";
		tagChanged(tag.name, null);
	});
}
