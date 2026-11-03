/**
 * Text search helpers for transcripts: normalisation, a Russian stemmer and
 * the FTS5 query builder. Both the indexed documents and the queries go
 * through `terms()`, so "врачом" in a query finds "врач" in a document.
 */

/** Lower case, ё folded to е, split into letter/digit runs. */
export function words(text: string): string[] {
	return text.toLowerCase().replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) ?? [];
}

const CYRILLIC = /^[а-я]+$/;

/** Stems Cyrillic words, keeps others as they are. */
export function terms(text: string): string[] {
	return words(text).map(w => CYRILLIC.test(w) ? stem(w) : w);
}

// ---- Snowball Russian stemmer (https://snowballstem.org/algorithms/russian/stemmer.html)

const VOWELS = new Set("аеиоуыэюя");
const PERFECTIVE_GERUND_1 = ["в", "вши", "вшись"];
const PERFECTIVE_GERUND_2 = ["ив", "ивши", "ившись", "ыв", "ывши", "ывшись"];
const ADJECTIVE = ["ее", "ие", "ые", "ое", "ими", "ыми", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "его", "ого", "ему", "ому", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"];
const PARTICIPLE_1 = ["ем", "нн", "вш", "ющ", "щ"];
const PARTICIPLE_2 = ["ивш", "ывш", "ующ"];
const REFLEXIVE = ["ся", "сь"];
const VERB_1 = ["ла", "на", "ете", "йте", "ли", "й", "л", "ем", "н", "ло", "но", "ет", "ют", "ны", "ть", "ешь", "нно"];
const VERB_2 = ["ила", "ыла", "ена", "ейте", "уйте", "ите", "или", "ыли", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ило", "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ую", "ю"];
const NOUN = ["а", "ев", "ов", "ие", "ье", "е", "иями", "ями", "ами", "еи", "ии", "и", "ией", "ей", "ой", "ий", "й", "иям", "ям", "ием", "ем", "ам", "ом", "о", "у", "ах", "иях", "ях", "ы", "ь", "ию", "ью", "ю", "ия", "ья", "я"];
const SUPERLATIVE = ["ейш", "ейше"];
const DERIVATIONAL = ["ост", "ость"];

/** Start of the region after the first vowel-consonant pair at or after `from`. */
function regionAfter(word: string, from: number) {
	for (let i = from + 1; i < word.length; i++)
		if (!VOWELS.has(word[i]) && VOWELS.has(word[i - 1])) return i + 1;
	return word.length;
}

export function stem(input: string): string {
	let word = input.replaceAll("ё", "е");
	let rv = word.length;
	for (let i = 0; i < word.length; i++) if (VOWELS.has(word[i])) { rv = i + 1; break; }
	const r2 = regionAfter(word, regionAfter(word, 0));

	/**
	 * Removes the longest of `group1` (which must follow "а" or "я") or `group2`
	 * found within RV. Returns whether something was removed.
	 */
	const strip = (group1: string[], group2: string[] = []) => {
		let best = "", needsAYa = false;
		for (const s of group1) if (s.length > best.length && word.endsWith(s)) { best = s; needsAYa = true; }
		for (const s of group2) if (s.length > best.length && word.endsWith(s)) { best = s; needsAYa = false; }
		if (!best) return false;
		const at = word.length - best.length;
		if (at < rv) return false;
		if (needsAYa && (at - 1 < rv || (word[at - 1] !== "а" && word[at - 1] !== "я"))) return false;
		word = word.slice(0, at);
		return true;
	};

	// Step 1
	if (!strip(PERFECTIVE_GERUND_1, PERFECTIVE_GERUND_2)) {
		strip([], REFLEXIVE);
		if (strip([], ADJECTIVE)) strip(PARTICIPLE_1, PARTICIPLE_2);
		else if (!strip(VERB_1, VERB_2)) strip([], NOUN);
	}
	// Step 2
	strip([], ["и"]);
	// Step 3: derivational endings only count inside R2
	for (const s of DERIVATIONAL)
		if (word.endsWith(s) && word.length - s.length >= r2 && word.length - s.length >= rv) { word = word.slice(0, -s.length); break; }
	// Step 4
	if (word.endsWith("нн") && word.length - 2 >= rv) word = word.slice(0, -1);
	else if (strip([], SUPERLATIVE)) { if (word.endsWith("нн") && word.length - 2 >= rv) word = word.slice(0, -1); }
	else if (word.endsWith("ь") && word.length - 1 >= rv) word = word.slice(0, -1);
	return word;
}

// ---- queries

/** Words that only glue a phrase together; a description rarely contains them. */
const STOP_WORDS = new Set([
	"и", "в", "во", "на", "с", "со", "к", "ко", "у", "о", "об", "обо", "от", "из", "за", "по", "под", "над", "при",
	"про", "для", "до", "без", "а", "но", "да", "же", "ли", "бы", "или",
	"a", "an", "the", "of", "in", "on", "and", "or", "to"
]);
const MAX_QUERY_TERMS = 12;

function distance(a: string, b: string, limit: number) {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			best = Math.min(best, row[j]);
		}
		if (best > limit) return limit + 1;
		prev = row;
	}
	return prev[b.length];
}

/** Indexed terms with the number of documents holding each. */
export type Vocabulary = Map<string, number>;

/**
 * Close spellings of a term that is not in the index: within one edit for
 * short terms, two for long ones, most common first.
 */
function nearTerms(term: string, vocabulary: Vocabulary) {
	const limit = term.length < 4 ? 0 : term.length < 7 ? 1 : 2;
	if (limit === 0) return [];
	const found: { term: string, d: number, docs: number }[] = [];
	for (const [candidate, docs] of vocabulary) {
		const d = distance(term, candidate, limit);
		if (d <= limit) found.push({ term: candidate, d, docs });
	}
	return found.sort((a, b) => a.d - b.d || b.docs - a.docs).slice(0, 8).map(f => f.term);
}

const quote = (term: string) => `"${term}"`;

/**
 * Builds FTS5 queries for a search string: `all` needs every word, `any`
 * (null for a single word) is the fallback when nothing has them all. Words
 * missing from the index are widened to a prefix and to close spellings.
 * Null when nothing searchable is left.
 */
export function ftsQuery(query: string, vocabulary: Vocabulary): { all: string, any: string | null } | null {
	const unique = [...new Set(
		words(query)
			.filter(w => !STOP_WORDS.has(w))
			.map(w => CYRILLIC.test(w) ? stem(w) : w)
	)].slice(0, MAX_QUERY_TERMS);
	if (unique.length === 0) return null;

	const groups = unique.map(term => {
		if (vocabulary.has(term)) return quote(term);
		const options = [`${quote(term)}*`, ...nearTerms(term, vocabulary).map(quote)];
		return options.length === 1 ? options[0] : `(${options.join(" OR ")})`;
	});
	return { all: groups.join(" AND "), any: groups.length > 1 ? groups.join(" OR ") : null };
}
