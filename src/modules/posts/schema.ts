import { z } from 'zod';
import { isStoredMedia } from '../../lib/storage';

// A picture uploaded with POST /v1/images?purpose=post_image (our storage only, never a link to elsewhere)
const storedPicture = z.string().max(2048).refine((url) => isStoredMedia(url) && url.includes('/img/post_image/'), 'Upload the picture first');
const postImage = z.object({
    url: storedPicture,
    width: z.number().int().min(1).max(8000),
    height: z.number().int().min(1).max(8000),
    variants: z.array(z.object({ url: storedPicture, width: z.number().int().min(1), height: z.number().int().min(1) })).max(4).default([]),
});
import { commentBody, communityRef, httpUrl, pageQuery, postBody, title, voteValue, commentSort } from '../../shared/validation';

export const createPostSchema = z
    .object({
        community: communityRef,
        type: z.enum(['text', 'link', 'image']).default('text'),
        title,
        body: postBody.default(''),
        url: httpUrl.optional(),
        image: postImage.optional(),
        is_anonymous: z.boolean().default(false),
        is_nsfw: z.boolean().default(false),
        flair_id: z.uuid().optional(),
        turnstile_token: z.string().max(4096).optional(),
    })
    .refine((post) => post.type !== 'link' || post.url, { message: 'A link post needs a URL', path: ['url'] })
    .refine((post) => post.type !== 'image' || post.image, { message: 'A picture post needs a picture', path: ['image'] });

// Titles can't change after posting (comments would no longer match); the body, NSFW flag and flair can
export const updatePostSchema = z
    .object({ body: postBody.optional(), is_nsfw: z.boolean().optional(), flair_id: z.uuid().nullable().optional() })
    .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const voteSchema = z.object({ value: voteValue });

export const createCommentSchema = z.object({
    body: commentBody,
    parent_id: z.uuid().optional(),
    is_anonymous: z.boolean().default(false),
});

export const commentsQuery = pageQuery.extend({
    sort: commentSort,
    limit: z.coerce.number().int().min(1).max(100).default(20),
    // How many reply levels to include under each comment, and how many replies per comment
    depth: z.coerce.number().int().min(0).max(8).default(3),
    replies: z.coerce.number().int().min(0).max(20).default(3),
});
