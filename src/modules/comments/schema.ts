import { z } from 'zod';
import { commentBody, commentSort, pageQuery, voteValue } from '../../shared/validation';

export const updateCommentSchema = z.object({ body: commentBody });

export const voteSchema = z.object({ value: voteValue });

export const repliesQuery = pageQuery.extend({
    sort: commentSort,
    limit: z.coerce.number().int().min(1).max(100).default(20),
    depth: z.coerce.number().int().min(0).max(8).default(3),
    replies: z.coerce.number().int().min(0).max(20).default(3),
});
