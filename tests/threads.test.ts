import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

type Node = { body: string; depth: number; replies: Node[]; more_replies: number; short_id: string; id: string };

describe('comment threads', () => {
    it('stores root, depth and path, and loads a thread with depth and fan-out caps', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');

        // A chain five deep, and five replies under the top comment
        const top = await createComment(alice.agent, post.id, { body: 'level 0' });
        let parent = top;
        for (let level = 1; level <= 4; level++) {
            parent = await createComment(alice.agent, post.id, { body: `level ${level}`, parent_id: parent.id });
        }
        for (let i = 0; i < 4; i++) await createComment(alice.agent, post.id, { body: `sibling ${i}`, parent_id: top.id });

        const deepest = await prisma.comment.findUniqueOrThrow({ where: { id: parent.id } });
        expect(deepest.depth).toBe(4);
        expect(deepest.root_id).toBe(top.id);
        expect(deepest.path.split('/')).toHaveLength(5);
        expect(deepest.path.startsWith(top.short_id)).toBe(true);

        const thread = await api().get(`/v1/posts/${post.id}/comments?sort=old&depth=2&replies=2`);
        const [root] = thread.body.comments as Node[];
        expect(root.replies.map((reply) => reply.body)).toEqual(['level 1', 'sibling 0']);
        expect(root.more_replies).toBe(3);
        const level2 = root.replies[0].replies;
        expect(level2.map((reply) => reply.body)).toEqual(['level 2']);
        // Below the depth cap: nothing loaded, but the count says there is more
        expect(level2[0].replies).toEqual([]);
        expect(level2[0].more_replies).toBe(1);

        // "Continue thread" from level 2 picks up where it stopped
        const more = await api().get(`/v1/comments/${level2[0].id}/replies?depth=5`);
        expect(more.body.comments.map((c: Node) => c.body)).toEqual(['level 3']);
        expect(more.body.comments[0].replies[0].body).toBe('level 4');

        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).comment_count).toBe(9);
    });

    it('pages top-level comments with a cursor and no duplicates', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        for (let i = 0; i < 7; i++) await createComment(alice.agent, post.id, { body: `c${i}` });

        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const query: string = `sort=new&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
            const page = await api().get(`/v1/posts/${post.id}/comments?${query}`);
            seen.push(...page.body.comments.map((c: Node) => c.body));
            cursor = page.body.next_cursor;
        } while (cursor);

        expect(seen).toEqual(['c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0']);
        expect((await api().get(`/v1/posts/${post.id}/comments?cursor=garbage`)).status).toBe(400);
    });

    it('puts pinned comments first', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const rules = await createComment(alice.agent, post.id, { body: 'read the rules' });
        await createComment(alice.agent, post.id, { body: 'newer' });
        await alice.agent.post(`/v1/comments/${rules.id}/moderation`).send({ action: 'pin' });

        const thread = await api().get(`/v1/posts/${post.id}/comments?sort=new`);
        expect(thread.body.comments.map((c: Node) => c.body)).toEqual(['read the rules', 'newer']);
    });
});
