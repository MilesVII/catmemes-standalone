import { Post, Tag } from "./api";
import { RampikePagination } from "./components/pagination";

export type State = {
	tags: Tag[],
	page: {
		posts: Post[],
		pager: RampikePagination
	},
	/** Searched tag name. */
	search: null | Tag["name"],
	/** Text searched in picture transcripts. */
	query: null | string,
	loading: boolean,
	auth: boolean,
	/** Suggester token held by this browser, if any. */
	suggester: { expiry: number } | null,
	/** Tag suggestion mode: shows the tag input on posts for suggesters. */
	suggesting: boolean,
	/** Admin: list only posts with pending suggestions. */
	suggestedOnly: boolean
};