import { mudcrack } from "rampike";

const TAG_NAME = "rampike-pages";
const ATTRS = ["page", "distance", "pageCount"];

class RampikePages extends HTMLElement {
	static get observedAttributes() { return ATTRS; }
	attributeChangedCallback(name: string, oldValue: string, value: string) {
		if (!ATTRS.includes(name)) return;
		if (oldValue === value) return;
		this[name] = parseInt(value, 10);
	}
	
	private readAttribute(key: string, def: number) {
		const raw = this.getAttribute(key);
		return raw ? parseInt(raw, 10) : def;
	}

	get page() { return this.readAttribute("page", 0) }
	set page(value: number) {
		this.setAttribute("page", `${value}`);
		this.update();
	}
	get distance() { return this.readAttribute("distance", 3) }
	set distance(value: number) {
		this.setAttribute("distance", `${value}`);
		this.update();
	}
	get pageCount() { return this.readAttribute("pageCount", 0) }
	set pageCount(value: number) {
		this.setAttribute("pageCount", `${value}`);
		this.update();
	}

	private links() {
		const r: number[] = [];
		let jam = false;
		for (let i = 0; i < this.pageCount; ++i){
			const distances = [
				Math.abs(i - 0),
				Math.abs(i - (this.page)),
				Math.abs(i - (this.pageCount - 1))
			];

			if (Math.min(...distances) < (this.distance)){
				r.push(i);
				jam = false;
			} else {
				if (!jam)
					r.push(-1);
				jam = true;
			}
		}
		return r;
	}
	private update() {
		this.innerHTML = "";
		this.append(...this.links().map(page => {
			const current = page === this.page;
			const ellipsis = page === -1;

			const contents = ellipsis ? "…" : `${page + 1}`;
			const events = (ellipsis || current) ? {} : {
				"click": () => this.pick(page)
			}
			const attributes = current ? { "data-current": "" } : {};
			return mudcrack({
				tagName: ellipsis ? "span" : "button",
				attributes,
				events,
				contents
			});
		}));
	}

	private pick(page: number) {
		this.dispatchEvent(new CustomEvent("pick", {
			detail: {
				page
			},
			// bubbles: true,
			// cancelable: true
		}));
	}

	constructor() {
		super();
		this.update();
	}
};

export function define() {
	window.customElements.define(TAG_NAME, RampikePages);
}
export type RampikePagination = RampikePages;