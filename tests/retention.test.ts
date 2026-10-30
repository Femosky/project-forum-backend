import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { devOutbox } from '../src/lib/email';
import { emailToken } from '../src/lib/emailTokens';
import { sendDigests, sendReplyEmails } from '../src/modules/notifications/emails';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

const verified = (id: string) => prisma.user.update({ where: { id }, data: { email_verified_at: new Date() } });
const mail = (to: string) => devOutbox.filter((item) => item.to === to);
// 9:00 in Lagos, after the digest hour
const MORNING = new Date('2030-01-15T08:00:00Z');

describe('reply emails', () => {
    it('groups replies, waits 15 minutes between emails, and honours settings and unsubscribe', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await verified(alice.user.id);
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        await createComment(bob.agent, post.id, { body: 'First reply' });
        await createComment(bob.agent, post.id, { body: 'Second reply' });

        const before = mail('alice@example.test').length;
        await sendReplyEmails();
        const sent = mail('alice@example.test').slice(before);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe('2 new replies on Project Forum');
        expect(sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

        await createComment(bob.agent, post.id, { body: 'Third reply' });
        await sendReplyEmails();
        expect(mail('alice@example.test').length).toBe(before + 1);
        await sendReplyEmails(new Date(Date.now() + 16 * 60 * 1000));
        expect(mail('alice@example.test').length).toBe(before + 2);

        // One-click, as a mail app sends it
        const token = emailToken({ kind: 'replies', userId: alice.user.id });
        await api().post(`/v1/email/unsubscribe?token=${token}`).type('form').send({ 'List-Unsubscribe': 'One-Click' }).expect(200);
        expect((await alice.agent.get('/v1/notifications/settings')).body.settings.email_replies).toBe(false);
        await createComment(bob.agent, post.id, { body: 'Fourth reply' });
        await sendReplyEmails(new Date(Date.now() + 60 * 60 * 1000));
        expect(mail('alice@example.test').length).toBe(before + 2);
    });
});

describe('the digest', () => {
    async function busyCommunity() {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await verified(bob.user.id);
        await createCommunity(alice.agent, 'lounge');
        await bob.agent.put('/v1/communities/lounge/membership').send({}).expect(200);
        const first = await createPost(alice.agent, 'lounge', { title: 'A good first post' });
        const second = await createPost(alice.agent, 'lounge', { title: 'A good second post' });
        await prisma.post.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { score: 5, created_at: new Date(MORNING.getTime() - 86400000) } });
        return { alice, bob };
    }

    it('sends the best posts weekly, with hide links, then waits', async () => {
        const { bob } = await busyCommunity();
        const before = mail('bob@example.test').length;
        await sendDigests(MORNING);
        const [digest] = mail('bob@example.test').slice(before);
        expect(digest.text).toContain('A good first post');
        expect(digest.text).toContain('Hide c/lounge');

        await sendDigests(new Date(MORNING.getTime() + 2 * 86400000));
        expect(mail('bob@example.test').length).toBe(before + 1);

        await api().post('/v1/email/unsubscribe').send({ token: emailToken({ kind: 'hide', userId: bob.user.id, ref: 'lounge' }) }).expect(200);
        expect((await bob.agent.get('/v1/notifications/settings')).body.hidden_communities).toEqual(['lounge']);
    });

    it('skips thin weeks, the night before the send hour, and people who stopped opening it', async () => {
        const { bob } = await busyCommunity();
        const before = mail('bob@example.test').length;
        await sendDigests(new Date('2030-01-15T03:00:00Z'));
        expect(mail('bob@example.test').length).toBe(before);

        await prisma.post.updateMany({ data: { score: 0 } });
        await sendDigests(MORNING);
        expect(mail('bob@example.test').length).toBe(before);

        await prisma.post.updateMany({ data: { score: 5 } });
        await prisma.user.update({ where: { id: bob.user.id }, data: { digest_unopened: 8 } });
        await sendDigests(MORNING);
        expect(mail('bob@example.test').length).toBe(before);
    });
});
