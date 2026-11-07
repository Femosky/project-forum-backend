import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Request, Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { HttpError, badRequest, forbidden, notFound, parse, unauthorized } from '../../lib/http';
import { commentBody, communityRef, postBody, title, username } from '../../shared/validation';
import { idOrShortId } from '../../lib/ids';
import { toPublicComment, toPublicPost } from '../../lib/serializers';
import { SITE_ACCOUNT_USERNAME } from '../../shared/site';
import { findCommunity } from '../communities/access';
import { assertCommentable, createComment } from '../comments/service';
import { notifyForComment } from '../notifications/service';
import { switchLive } from '../posts/live';
import { createPost } from '../posts/service';
import { indexNowJob, postPath } from '../seo/jobs';
import { audit } from '../staff/service';

// Opening threads as seed accounts (is_seed: the launch personas and the site account), which have no password.
// Text threads only, never replies or votes: replies to real people come from real accounts.
//
// Two ways in: owners and admins from the admin panel (admin/routes.ts), and the daily trending routine with
// SEED_POST_KEY as a bearer token (/v1/seed-posts, below). The key route is off while the key is unset and opens at
// most KEY_POSTS_PER_DAY threads a day. Every thread goes to the staff audit log as seed_post.
//
// The key can also keep a seed-authored thread going without anyone at a desk (live match threads): top-level
// replies as the site account only (site_team, never the personas), at most KEY_COMMENTS_PER_DAY a day, audited as
// seed_comment; and the live switch on those threads, audited as seed_live. On the site account's own live thread
// those replies show as "Update", since the web labels the author's top-level replies that way.

export const seedPostSchema = z.object({ as: username, community: communityRef, title, body: postBody.default('') });

const KEY_POSTS_PER_DAY = 10;
const KEY_COMMENTS_PER_DAY = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function seedAccounts() {
    return prisma.user.findMany({ where: { is_seed: true, status: 'active' }, select: { username: true, display_name: true }, orderBy: { username: 'asc' } });
}

export async function createSeedPost(request: Request, input: z.infer<typeof seedPostSchema>, via: 'admin' | 'key' = 'admin') {
    const as = input.as.toLowerCase();
    const author = await prisma.user.findUnique({ where: { username: as }, select: { id: true, is_seed: true, status: true } });
    if (!author?.is_seed || author.status !== 'active') throw badRequest('Pick one of the seed accounts.', 'not_seed_account');
    const community = await findCommunity(input.community);
    if (community.status !== 'active') throw badRequest('That community is not active.', 'community_inactive');

    const post = await createPost({
        communityId: community.id,
        authorId: author.id,
        type: 'text',
        title: input.title,
        body: input.body,
        is_anonymous: false,
        is_nsfw: community.is_nsfw,
        held_reason: null,
        shadow_hidden: false,
    });
    const path = postPath(post);
    if (community.visibility === 'public') await indexNowJob.enqueue({ paths: [path] });
    await audit(request, 'seed_post', { type: 'community', id: community.id }, { as, post_id: post.id, via });
    return { id: post.id, short_id: post.short_id, path };
}

// Compared as hashes so the comparison takes the same time whatever the length
function keyMatches(header: string | undefined) {
    const key = env.SEED_POST_KEY;
    const given = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key || !given) return false;
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(given), digest(key));
}

export const seedPostKeyRoutes = Router();

seedPostKeyRoutes.use((request, _response, next) => {
    if (!env.SEED_POST_KEY) return next(notFound());
    if (!keyMatches(request.get('authorization'))) return next(unauthorized('A valid posting key is needed.', 'invalid_key'));
    next();
});

seedPostKeyRoutes.get('/accounts', async (_request, response) => {
    response.json({ accounts: await seedAccounts() });
});

// The key may only touch threads a seed account opened, still open, in an active community
async function seedThread(ref: string) {
    const post = await prisma.post.findUnique({
        where: idOrShortId(ref) as Prisma.PostWhereUniqueInput,
        include: { author: { select: { is_seed: true } }, community: { select: { status: true } } },
    });
    if (!post) throw notFound('Post not found');
    if (!post.author.is_seed) throw forbidden('The posting key only works on threads a seed account opened.', 'not_seed_thread');
    if (post.community.status !== 'active') throw badRequest('That community is not active.', 'community_inactive');
    return post;
}

const seedCommentSchema = z.object({ body: commentBody });

seedPostKeyRoutes.post('/:post/comments', async (request, response) => {
    const { body } = parse(seedCommentSchema, request.body);
    const post = await seedThread(String(request.params.post));
    assertCommentable(post);
    const today = await prisma.staffAudit.count({
        where: { action: 'seed_comment', staff_id: null, created_at: { gte: new Date(Date.now() - DAY_MS) } },
    });
    if (today >= KEY_COMMENTS_PER_DAY) {
        throw new HttpError(429, 'daily_limit', `The posting key adds at most ${KEY_COMMENTS_PER_DAY} replies a day.`);
    }
    const site = await prisma.user.findUnique({ where: { username: SITE_ACCOUNT_USERNAME }, select: { id: true, status: true } });
    if (!site || site.status !== 'active') throw badRequest('The site account is missing or not active.', 'site_account_unavailable');

    const comment = await createComment({ postId: post.id, authorId: site.id, body, isAnonymous: false, heldReason: null, shadowHidden: false });
    await audit(request, 'seed_comment', { type: 'post', id: post.id }, { as: SITE_ACCOUNT_USERNAME, comment_id: comment.id, via: 'key' });
    await notifyForComment(comment);
    response.status(201).json({ comment: { ...toPublicComment(comment, post.community_id, null), replies: [], more_replies: 0 } });
});

const seedLiveSchema = z.object({ live: z.boolean() });

seedPostKeyRoutes.put('/:post/live', async (request, response) => {
    const { live } = parse(seedLiveSchema, request.body);
    const post = await seedThread(String(request.params.post));
    const updated = await switchLive(post, live);
    await audit(request, 'seed_live', { type: 'post', id: post.id }, { live, via: 'key' });
    response.json({ post: toPublicPost(updated, null) });
});

seedPostKeyRoutes.post('/', async (request, response) => {
    const input = parse(seedPostSchema, request.body);
    const today = await prisma.staffAudit.count({
        where: { action: 'seed_post', staff_id: null, created_at: { gte: new Date(Date.now() - DAY_MS) } },
    });
    if (today >= KEY_POSTS_PER_DAY) throw new HttpError(429, 'daily_limit', `The posting key opens at most ${KEY_POSTS_PER_DAY} threads a day.`);
    response.status(201).json({ post: await createSeedPost(request, input, 'key') });
});
