import { CommentService } from '../services/CommentService';
import { PostService } from '../services/PostService';

interface PaginationResponseDetails {
    current_page: number;
    total_pages: number;
    total_items: number;
    has_next_page: boolean;
    has_previous_page: boolean;
    next_page: number;
    previous_page: number;
}

export interface PaginationResponse {
    parent: PaginationResponseDetails;
    child?: PaginationResponseDetails;
}

type PaginationItemType = 'post' | 'comment';

class PaginationUtils {
    static preparePaginationResponse(
        pageNumber: number,
        totalPages: number,
        totalPosts: number
    ): PaginationResponseDetails {
        return {
            current_page: pageNumber,
            total_pages: totalPages,
            total_items: totalPosts,
            has_next_page: pageNumber < totalPages,
            has_previous_page: pageNumber > 1,
            next_page: pageNumber < totalPages ? pageNumber + 1 : null,
            previous_page: pageNumber > 1 ? pageNumber - 1 : null,
        } as PaginationResponseDetails;
    }

    static calculatePaginationDetails(
        type: PaginationItemType,
        page: any,
        limit: any
    ): { pageNumber: number; limitNumber: number; offset: number } {
        const pageNumber = Math.max(
            1,
            parseInt(page as string) ||
                (type === 'post' ? PostService.DEFAULT_PAGE_NUMBER : CommentService.DEFAULT_REPLY_PAGE_NUMBER)
        );

        const limitNumber = Math.min(
            Math.max(
                1,
                parseInt(limit as string) ||
                    (type === 'post' ? PostService.DEFAULT_LIMIT : CommentService.DEFAULT_LIMIT)
            ),
            100
        );

        const offset = (pageNumber - 1) * limitNumber;

        return { pageNumber, limitNumber, offset };
    }

    static prepareParentChildPaginationResponse(
        parent: PaginationResponseDetails,
        child: PaginationResponseDetails
    ): PaginationResponse {
        return {
            parent,
            child,
        } as PaginationResponse;
    }
}

export default PaginationUtils;
