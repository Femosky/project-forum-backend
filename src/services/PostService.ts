export class PostService {
    static readonly SortBy = {
        NEWEST: 'newest',
        OLDEST: 'oldest',
        MOST_UPVOTED: 'most_upvoted',
        MOST_DOWNVOTED: 'most_downvoted',
        MOST_COMMENTED: 'most_commented',
    };

    static readonly DEFAULT_SORT_BY = this.SortBy.MOST_UPVOTED;
    static readonly DEFAULT_PAGE_NUMBER = 1;
    static readonly DEFAULT_LIMIT = 10;

    static async getSortOrder(sort: string) {
        switch (sort) {
            case this.SortBy.NEWEST:
                return { created_at: 'desc' };
            case this.SortBy.OLDEST:
                return { created_at: 'asc' };
            case this.SortBy.MOST_UPVOTED:
                return {
                    upvoters: { _count: 'desc' },
                    created_at: 'desc',
                };
            case this.SortBy.MOST_DOWNVOTED:
                return {
                    downvoters: { _count: 'desc' },
                    created_at: 'desc',
                };
            case this.SortBy.MOST_COMMENTED:
                return {
                    comments: { _count: 'desc' },
                    created_at: 'desc',
                };
            default:
                // Default to most upvoted
                return {
                    upvoters: { _count: 'desc' },
                    created_at: 'desc',
                };
        }
    }
}
