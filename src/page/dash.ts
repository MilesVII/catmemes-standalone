import { mudcrack } from "rampike";
import { changePassword, Sessions, signin, signout, vibecheck } from "./api";
import { RampikeTabs } from "./components/tabs";
import { State } from "./types";

export function attachDash(state: State, onAuth: () => void) {
	const dashTabs =        document.querySelector<RampikeTabs>("#rp-tabs-dash")
	const vibecheckButton = document.querySelector<HTMLButtonElement>("#dash-check");
	const loginField =      document.querySelector<HTMLInputElement>("#dash-login");
	const passwordField =   document.querySelector<HTMLInputElement>("#dash-pass");
	const signinButton =    document.querySelector<HTMLButtonElement>("#dash-signin");
	const sessionList =     document.querySelector<HTMLDivElement>(".dash-session-list");
	const changeField =     document.querySelector<HTMLInputElement>("#dash-change-field");
	const changeButton =    document.querySelector<HTMLButtonElement>("#dash-change-button");

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
	vibecheckButton.addEventListener("click", async () => {
		const vibe = await vibecheck();
		if (vibe) {
			fillSessionList(vibe);
			dashTabs.tab = "admin";
			state.auth = true;
			onAuth();
		} else {
			dashTabs.tab = "signin";
		}
	});
	signinButton.addEventListener("click", async () => {
		const result = await signin(loginField.value, passwordField.value);
		if (!result) return;
		
		fillSessionList(result);
		dashTabs.tab = "admin";
		state.auth = true;
		onAuth();
	});
	
	changeButton.addEventListener("click", () => {
		changePassword(changeField.value).then(() => dashTabs.tab = "signin");
		state.auth = false;
	});
}
