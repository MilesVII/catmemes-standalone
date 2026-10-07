import { Post, Tag } from "./api";
import { RampikePagination } from "./components/pagination";

export type State = {
	tags: Tag[],
	page: {
		posts: Post[],
		pager: RampikePagination
	},
	search: null | Tag["id"],
	loading: boolean,
	auth: boolean
};