
const TAG_NAME = {
	tab:  "rampike-tab",
	tabs: "rampike-tabs",
}

class RampikeTab extends HTMLElement {
	static get observedAttributes() { return ["key"]; }
	attributeChangedCallback(name: string, oldValue: string, value: string) {
		if (name !== "key") return;
		if (oldValue === value) return;
		this.key = value;
	}

	key: string;

	constructor() {
		super();
		this.style.display = "contents";
		this.key = this.getAttribute("key");
	}
};

class RampikeTabContainer extends HTMLElement {
	static get observedAttributes() { return ["tab"]; }
	attributeChangedCallback(name: string, oldValue: string, value: string) {
		if (name !== "tab") return;
		if (oldValue === value) return;
		this.tab = value;
	}

	constructor() {
		super();
		this.style.display = "contents";
		this.tab = this.getAttribute("tab");
	}

	set tab(value: string) {
		this.querySelectorAll<RampikeTab>(TAG_NAME.tab).forEach(tab => {
			if (findParentTabContainer(tab)?.id !== this.id) return;

			const hidden = tab.key !== value;
			tab.hidden = hidden;
			tab.style.display = hidden ? "none" : "contents";
		});
		this.setAttribute("tab", value);
	}
}

export function define() {
	window.customElements.define(TAG_NAME.tab,  RampikeTab);
	window.customElements.define(TAG_NAME.tabs, RampikeTabContainer);
}
export type RampikeTabs = RampikeTabContainer;

function findParentTabContainer(origin: HTMLElement) {
	let target = origin.parentElement;
	while (target !== null && target.tagName !== TAG_NAME.tabs.toUpperCase()) {
		target = target.parentElement;
	}
	return target;
}
