import { randomInt, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../src/prismaConnection';
import { hotRank, wilsonLowerBound } from '../src/lib/ranking';
import { slugify } from '../src/lib/slug';
import { SEED_ACCOUNTS } from './launch/accounts';
import { LAUNCH_COMMUNITIES, type SeedComment } from './launch/content';
import { SITE_ACCOUNT_NAME, SITE_ACCOUNT_USERNAME } from '../src/shared/site';

// Launch content: the communities, threads and replies in prisma/launch/, written by the seed accounts there.
//
//   npm run seed:launch                                  add the launch content (stops if it is already there)
//   npm run seed:launch -- --reset --confirm=<db host>   first wipe ALL content, then add the launch content
//   add --lead=<username> to choose who is Lead mod of the communities (default femi; the account must exist). The
//   site's own account owns them.
//
// --reset deletes every community, post, comment, vote, save, notification and content report, and the mod log
// for them. Users, sessions, ads and the blocklist are kept, and karma goes back to 0 because the votes are gone.
// --confirm must repeat the database host, so the live database is never wiped by accident.

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;

function option(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

// Same alphabet and length as src/lib/ids.ts (nanoid is ESM-only, so it can't load under ts-node)
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const usedShortIds = new Set<string>();
function shortId(): string {
    for (;;) {
        const id = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
        if (!usedShortIds.has(id)) {
            usedShortIds.add(id);
            return id;
        }
    }
}

// Seeded random numbers, so a re-run picks the same voters
let seed = 20270116;
function random(): number {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(items: T[], count: number): T[] {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
}

async function wipeContent(tx: Prisma.TransactionClient) {
    const counts = {
        notifications: (await tx.notification.deleteMany()).count,
        saved_comments: (await tx.savedComment.deleteMany()).count,
        saved_posts: (await tx.savedPost.deleteMany()).count,
        comment_votes: (await tx.commentVote.deleteMany()).count,
        post_votes: (await tx.postVote.deleteMany()).count,
        comments: (await tx.comment.deleteMany()).count,
        posts: (await tx.post.deleteMany()).count,
        reports: (await tx.report.deleteMany({ where: { target_type: { in: ['post', 'comment', 'community'] } } })).count,
        mod_actions: (
            await tx.modAction.deleteMany({
                where: { OR: [{ community_id: { not: null } }, { target_type: { in: ['post', 'comment', 'community'] } }] },
            })
        ).count,
        // Members, mutes, join requests and flairs go with their community
        communities: (await tx.community.deleteMany()).count,
    };
    await tx.user.updateMany({ data: { karma: 0 } });
    console.log('Wiped:', counts);
}

async function main() {
    const url = new URL(process.env.DATABASE_URL ?? '');
    const host = url.hostname;
    console.log(`Database: ${host}${url.pathname}`);

    const reset = process.argv.includes('--reset');
    if (reset && option('confirm') !== host) {
        throw new Error(`--reset wipes all content. Add --confirm=${host} to confirm this database.`);
    }

    const leadName = option('lead') ?? 'femi';
    const lead = await prisma.user.findUnique({ where: { username: leadName } });
    if (!lead) throw new Error(`Lead account "${leadName}" doesn't exist. Pass --lead=<username>.`);
    const owner = await prisma.user.upsert({
        where: { username: SITE_ACCOUNT_USERNAME },
        create: { username: SITE_ACCOUNT_USERNAME, email: 'site-team@invalid.local', display_name: SITE_ACCOUNT_NAME, email_verified_at: new Date() },
        update: {},
    });

    if (!reset) {
        const existing = await prisma.community.count({
            where: { name: { in: LAUNCH_COMMUNITIES.map((community) => community.name.toLowerCase()) } },
        });
        if (existing > 0) throw new Error('Launch communities already exist. Use --reset to start over.');
    }

    const now = Date.now();
    const accounts = await Promise.all(
        SEED_ACCOUNTS.map((account) =>
            prisma.user.upsert({
                where: { username: account.username },
                create: {
                    username: account.username,
                    email: `${account.username}@seed.invalid`,
                    display_name: account.display_name,
                    avatar_id: `default_${1 + (account.username.length % 3)}`,
                    email_verified_at: new Date(now - account.days_old * DAY),
                    adult_attested_at: new Date(now - account.days_old * DAY),
                    created_at: new Date(now - account.days_old * DAY),
                },
                update: {},
            })
        )
    );
    const idOf = new Map(accounts.map((account) => [account.username, account.id]));
    const userId = (username: string) => {
        const id = idOf.get(username);
        if (!id) throw new Error(`Unknown seed account "${username}"`);
        return id;
    };
    const voterIds = accounts.map((account) => account.id);

    const communities: Prisma.CommunityCreateManyInput[] = [];
    const members: Prisma.CommunityMemberCreateManyInput[] = [];
    const posts: Prisma.PostCreateManyInput[] = [];
    const comments: Prisma.CommentCreateManyInput[] = [];
    const postVotes: Prisma.PostVoteCreateManyInput[] = [];
    const commentVotes: Prisma.CommentVoteCreateManyInput[] = [];
    const karma = new Map<string, number>();
    const addKarma = (id: string, amount: number) => karma.set(id, (karma.get(id) ?? 0) + amount);

    // Votes from seed accounts other than the author, timed after the item was posted
    function votes(authorId: string, up: number, down: number, after: number) {
        const voters = pick(
            voterIds.filter((id) => id !== authorId),
            up + down
        );
        return voters.map((voter, index) => ({
            user_id: voter,
            value: index < up ? 1 : -1,
            created_at: new Date(Math.min(after + (index + 1) * 7 * MINUTE, now)),
        }));
    }

    for (const [index, data] of LAUNCH_COMMUNITIES.entries()) {
        const communityId = randomUUID();
        const communityCreated = now - (14 - (index % 4)) * DAY;
        const memberIds = new Set<string>([owner.id, lead.id]);

        for (const thread of data.threads) {
            const postId = randomUUID();
            const postedAt = now - thread.ago * HOUR;
            const authorId = userId(thread.by);
            memberIds.add(authorId);

            let commentCount = 0;
            // Comments are spread over the hours after the post; nothing lands in the future
            const addComment = (comment: SeedComment, parent: { id: string; root: string | null; path: string; depth: number; at: number } | null, order: number) => {
                const id = randomUUID();
                const sid = shortId();
                const at = Math.min((parent?.at ?? postedAt) + (25 + order * 40 + Math.floor(random() * 30)) * MINUTE, now - MINUTE);
                const commenterId = userId(comment.by);
                memberIds.add(commenterId);
                const cast = votes(commenterId, comment.up, 0, at);
                const node = { id, root: parent ? (parent.root ?? parent.id) : null, path: parent ? `${parent.path}/${sid}` : sid, depth: parent ? parent.depth + 1 : 0, at };
                comments.push({
                    id,
                    short_id: sid,
                    post_id: postId,
                    author_id: commenterId,
                    parent_id: parent?.id ?? null,
                    root_id: node.root,
                    depth: node.depth,
                    path: node.path,
                    body: comment.body,
                    created_at: new Date(at),
                    updated_at: new Date(at),
                    upvote_count: comment.up,
                    score: comment.up,
                    reply_count: comment.replies.length,
                    best_rank: wilsonLowerBound(comment.up, 0),
                });
                commentVotes.push(...cast.map((vote) => ({ ...vote, comment_id: id, updated_at: vote.created_at })));
                addKarma(commenterId, comment.up);
                commentCount += 1;
                comment.replies.forEach((reply, replyOrder) => addComment(reply, node, replyOrder));

            };
            thread.comments.forEach((comment, order) => addComment(comment, null, order));

            const down = thread.down ?? 0;
            const score = thread.up - down;
            posts.push({
                id: postId,
                short_id: shortId(),
                slug: slugify(thread.title),
                author_id: authorId,
                community_id: communityId,
                title: thread.title,
                body: thread.body,
                created_at: new Date(postedAt),
                updated_at: new Date(postedAt),
                upvote_count: thread.up,
                downvote_count: down,
                score,
                comment_count: commentCount,
                hot_rank: hotRank(score, new Date(postedAt), commentCount),
            });
            postVotes.push(...votes(authorId, thread.up, down, postedAt).map((vote) => ({ ...vote, post_id: postId, updated_at: vote.created_at })));
            addKarma(authorId, score);
        }

        // Some readers join without posting
        for (const id of pick(voterIds, 8 + (index % 3) * 4)) memberIds.add(id);

        communities.push({
            id: communityId,
            name: data.name.toLowerCase(),
            name_styled: data.name,
            display_name: data.display_name,
            description: data.description,
            category: data.category,
            rules: data.rules,
            created_by: owner.id,
            created_at: new Date(communityCreated),
            updated_at: new Date(communityCreated),
            member_count: memberIds.size,
            post_count: data.threads.length,
        });
        for (const id of memberIds) {
            members.push({
                community_id: communityId,
                user_id: id,
                role: id === owner.id ? 'owner' : id === lead.id ? 'moderator' : 'member',
                mod_permission: id === lead.id ? 'lead' : 'all',
                joined_at: new Date(id === owner.id ? communityCreated : communityCreated + Math.floor(random() * 3 * DAY)),
            });
        }
    }

    await prisma.$transaction(
        async (tx) => {
            if (reset) await wipeContent(tx);
            await tx.community.createMany({ data: communities });
            await tx.communityMember.createMany({ data: members });
            await tx.post.createMany({ data: posts });
            // Parents before replies: they were pushed in that order, and createMany keeps it
            await tx.comment.createMany({ data: comments });
            await tx.postVote.createMany({ data: postVotes });
            await tx.commentVote.createMany({ data: commentVotes });
            for (const [id, amount] of karma) {
                await tx.user.update({ where: { id }, data: { karma: { increment: amount } } });
            }
        },
        { timeout: 120_000 }
    );

    console.log(
        `Added ${communities.length} communities, ${posts.length} posts, ${comments.length} comments, ` +
            `${postVotes.length + commentVotes.length} votes from ${accounts.length} seed accounts. Lead mod: ${leadName}.`
    );
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
