import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { findMentions } from '../src/modules/notifications/service';
import { createComment, createCommunity, createPost, signUp } from './helpers';

describe('notifications', () => {
    it('tells the post author about a top-level comment and the parent author about a reply', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'question' });

        const comment = await createComment(bob.agent, post.id, { body: 'an answer' });
        const aliceInbox = await alice.agent.get('/v1/notifications');
        expect(aliceInbox.status).toBe(200);
        expect(aliceInbox.body.unread_count).toBe(1);
        expect(aliceInbox.body.notifications[0]).toMatchObject({
            type: 'post_reply',
            actor: { username: 'bob' },
            post: { short_id: post.short_id, title: 'question', community: 'lounge' },
            comment: { short_id: comment.short_id, excerpt: 'an answer' },
            read_at: null,
        });

        await createComment(alice.agent, post.id, { body: 'thanks', parent_id: comment.id });
        const bobInbox = await bob.agent.get('/v1/notifications');
        expect(bobInbox.body.notifications.map((n: { type: string }) => n.type)).toEqual(['comment_reply']);

        // Your own comments never notify you
        expect((await alice.agent.get('/v1/notifications/unread-count')).body.count).toBe(1);
    });

    it('notifies mentioned users once, hides anonymous actors and respects blocks', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');

        // alice is the post author and is also mentioned: she gets the reply, not a second mention
        await createComment(bob.agent, post.id, { body: 'cc @carol and u/alice', is_anonymous: true });
        const carolInbox = await carol.agent.get('/v1/notifications');
        expect(carolInbox.body.notifications).toHaveLength(1);
        expect(carolInbox.body.notifications[0]).toMatchObject({ type: 'mention', actor: null });
        expect((await alice.agent.get('/v1/notifications')).body.notifications.map((n: { type: string }) => n.type)).toEqual(['post_reply']);

        await prisma.block.create({ data: { blocker_id: carol.user.id, blocked_id: bob.user.id } });
        await createComment(bob.agent, post.id, { body: 'hey @carol' });
        expect((await carol.agent.get('/v1/notifications/unread-count')).body.count).toBe(1);
    });

    it('marks notifications read and drops ones whose comment was deleted', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const first = await createComment(bob.agent, post.id);
        await createComment(bob.agent, post.id);

        const inbox = await alice.agent.get('/v1/notifications');
        const read = await alice.agent.post('/v1/notifications/read').send({ ids: [inbox.body.notifications[0].id] });
        expect(read.body.count).toBe(1);
        expect((await alice.agent.post('/v1/notifications/read').send({})).body.count).toBe(0);

        await bob.agent.delete(`/v1/comments/${first.id}`);
        expect((await alice.agent.get('/v1/notifications')).body.notifications).toHaveLength(1);

        // Someone else can't read or clear your notifications
        expect((await bob.agent.get('/v1/notifications')).body.notifications).toEqual([]);
    });

    it('finds mentions without matching emails or URLs', () => {
        expect(findMentions('thanks @Bob_1, u/carol and @bob_1 again')).toEqual(['bob_1', 'carol']);
        expect(findMentions('mail me at x@example.com or see https://site.com/u/dave')).toEqual([]);
    });
});
