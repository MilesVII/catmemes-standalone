import { mudcrack } from "rampike";
import { CoverageSnapshot } from "./api";

/** Pages per column, like weekdays in a contribution graph. */
const COLUMN_HEIGHT = 10;

/** 0 = no tagged posts, 4 = every post tagged, 1..3 in between. */
function level(tagged: number, total: number) {
	if (tagged <= 0 || total <= 0) return 0;
	if (tagged >= total) return 4;
	return Math.min(3, 1 + Math.floor((tagged / total) * 3));
}

const formatDate = (ms: number) =>
	new Date(ms).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Fills `.coverage-wrap` with one cell per page of the unfiltered list.
 * `current` is the highlighted page, or null while a filter is active
 * (the snapshot's pages don't line up with a filtered pager).
 */
export function renderCoverage(
	snapshot: CoverageSnapshot | null,
	current: number | null,
	pick: (page: number) => void
) {
	const wrap = document.querySelector<HTMLElement>(".coverage-wrap");
	const grid = document.querySelector<HTMLElement>(".coverage");
	if (!wrap || !grid) return;

	wrap.hidden = snapshot === null || snapshot.tagged.length === 0;
	if (snapshot === null || snapshot.tagged.length === 0) return;

	const { tagged, count, perPage } = snapshot;
	const pageSize = (page: number) => Math.min(perPage, count - page * perPage);

	grid.style.setProperty("--rows", `${COLUMN_HEIGHT}`);
	grid.innerHTML = "";
	grid.append(...tagged.map((n, page) => {
		const total = pageSize(page);
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
		const some = tagged.filter((n, page) => level(n, pageSize(page)) > 0).length;
		const ratio = Math.round(100 * some / tagged.length);
		summary.textContent =
			`с тегами ${sum} из ${count} постов, ~${ratio}%` +
			` · обновлено ${formatDate(snapshot.computedAt)}`;
	}
}
