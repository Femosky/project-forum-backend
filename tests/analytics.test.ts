import { beforeEach, describe, expect, it } from 'vitest';
import { sentForTests } from '../src/lib/analytics';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

const events = (name: string) => sentForTests.filter((event) => event.event === name);

describe('analytics', () => {
    beforeEach(() => {
        sentForTests.length = 0;
    });

    it('records the core loop without content or anything that links an anonymous post to its author', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'A named question', body: 'Named body text' });
        const secret = await createPost(alice.agent, 'lounge', { title: 'A private question', body: 'Private body text', is_anonymous: true });
        await createComment(alice.agent, post.id, { body: 'A reply to the named question' });
        await alice.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });

        expect(events('signup')).toEqual([expect.objectContaining({ distinct_id: alice.user.id, properties: { method: 'email' } })]);
        expect(events('post_created').map((event) => event.properties)).toEqual([
            { type: 'text', anonymous: false, community: 'lounge', held: false },
            { type: 'text', anonymous: true, community: undefined, held: false },
        ]);
        expect(events('comment_created')).toHaveLength(1);
        expect(events('vote')[0].properties).toEqual({ target: 'post', value: 1 });
        // One "active" per account per day, however many requests
        expect(events('user_active')).toHaveLength(1);

        const everything = JSON.stringify(sentForTests);
        for (const leak of [post.id, secret.id, secret.short_id, 'Private', 'Named body']) expect(everything).not.toContain(leak);
    });

    it('records first-page searches, from guests without a person profile', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: 'Agents and fees' });
        sentForTests.length = 0;

        await api().get('/v1/search?q=Yaba');
        await api().get('/v1/search?q=Yaba&page=2');
        await api().get('/v1/search?q=nothingmatches');

        expect(events('search').map((event) => [event.distinct_id, event.properties])).toEqual([
            ['guest', { type: 'posts', in_community: false, query: 'yaba', results: 1, no_results: false, corrected: false, $process_person_profile: false }],
            ['guest', { type: 'posts', in_community: false, query: 'nothingmatches', results: 0, no_results: true, corrected: false, $process_person_profile: false }],
        ]);
    });
});
