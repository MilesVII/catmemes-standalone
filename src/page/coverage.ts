import { mudcrack } from "rampike";

/** Pages per column, like weekdays in a contribution graph. */
const COLUMN_HEIGHT = 10;

/** 0 = no tagged posts, 4 = every post tagged, 1..3 in between. */
function level(tagged: number, total: number) {
	if (tagged <= 0 || total <= 0) return 0;
	if (tagged >= total) return 4;
	return Math.min(3, 1 + Math.floor((tagged / total) * 3));
}

/**
 * Fills `.coverage-wrap` with one cell per page. `tagged[i]` is the number of
 * posts with at least one tag on page i; the last page may be partial.
 */
export function renderCoverage(
	tagged: number[] | undefined,
	count: number,
	perPage: number,
	current: number,
	pick: (page: number) => void
) {
	const wrap = document.querySelector<HTMLElement>(".coverage-wrap");
	const grid = document.querySelector<HTMLElement>(".coverage");
	if (!wrap || !grid) return;

	wrap.hidden = tagged === undefined || tagged.length === 0;
	if (tagged === undefined || tagged.length === 0) return;

	grid.style.setProperty("--rows", `${COLUMN_HEIGHT}`);
	grid.innerHTML = "";
	grid.append(...tagged.map((n, page) => {
		const total = Math.min(perPage, count - page * perPage);
		const attributes: Record<string, string> = {
			title: `стр. ${page + 1}: ${n} из ${total} с тегами`,
			"aria-label": `страница ${page + 1}, ${n} из ${total} с тегами`,
			"data-level": `${level(n, total)}`
		};
		if (page === current) attributes["data-current"] = "";
		return mudcrack({
			tagName: "button",
			attributes,
			events: { click: () => pick(page) }
		});
	}));

	const summary = document.querySelector<HTMLElement>(".coverage-summary");
	if (summary) {
		const sum = tagged.reduce((a, b) => a + b, 0);
		const full = tagged.filter((n, page) => level(n, Math.min(perPage, count - page * perPage)) === 4).length;
		summary.textContent = `${sum} of ${count} posts tagged, ${full} of ${tagged.length} pages complete`;
	}
}
