import { mudcrack } from "rampike";
import { changePassword, Sessions, signin, signout, suggestIssue, vibecheck } from "./api";
import { RampikeTabs } from "./components/tabs";
import { State } from "./types";

type DashHooks = {
	/** `reload(true)` goes back to page 1, `reload(false)` re-fetches the current page. */
	reload: (firstPage: boolean) => void,
	/** Recomputes the tag coverage snapshot shown to everyone. */
	recalculateCoverage: () => Promise<void>
};

export function attachDash(state: State, { reload, recalculateCoverage }: DashHooks) {
	const dashTabs =        document.querySelector<RampikeTabs>("#rp-tabs-dash")
	const vibecheckButton = document.querySelector<HTMLButtonElement>("#dash-check");
	const loginField =      document.querySelector<HTMLInputElement>("#dash-login");
	const passwordField =   document.querySelector<HTMLInputElement>("#dash-pass");
	const signinButton =    document.querySelector<HTMLButtonElement>("#dash-signin");
	const sessionList =     document.querySelector<HTMLDivElement>(".dash-session-list");
	const changeField =     document.querySelector<HTMLInputElement>("#dash-change-field");
	const changeButton =    document.querySelector<HTMLButtonElement>("#dash-change-button");
	const suggestedButton = document.querySelector<HTMLButtonElement>("#dash-suggested");
	const coverageButton =  document.querySelector<HTMLButtonElement>("#dash-coverage");
	const issueButton =     document.querySelector<HTMLButtonElement>("#dash-issue");
	const issueLink =       document.querySelector<HTMLInputElement>("#dash-issue-link");

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
	signinButton.addEventListener("click", async () => {
		const result = await signin(loginField.value, passwordField.value);
		if (!result) return;
		authorized(result);
	});

	changeButton.addEventListener("click", () => {
		changePassword(changeField.value).then(() => dashTabs.tab = "signin");
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
}
