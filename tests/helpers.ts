import request from 'supertest';
import app from '../src/app';
import prisma from '../src/prismaConnection';
import { devOutbox } from '../src/lib/email';

export const api = () => request(app);
export type Agent = ReturnType<typeof request.agent>;

export const PASSWORD = 'Passw0rd!Passw0rd';

// Signs up a user and returns an agent that carries their auth cookies
export async function signUp(username: string, options: { admin?: boolean } = {}) {
    const agent = request.agent(app);
    const response = await agent
        .post('/v1/auth/signup')
        .send({ email: `${username}@example.test`, username, password: PASSWORD, is_adult: true });
    if (response.status !== 201) {
        throw new Error(`Signup failed for ${username}: ${JSON.stringify(response.body)}`);
    }
    if (options.admin) await prisma.user.update({ where: { username }, data: { role: 'admin' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });
    return { agent, user, password: PASSWORD };
}

export async function createCommunity(agent: Agent, name: string, fields: Record<string, unknown> = {}) {
    const response = await agent.post('/v1/communities').send({ name, description: 'test', ...fields });
    if (response.status !== 201) throw new Error(`Community create failed: ${JSON.stringify(response.body)}`);
    return response.body.community as { id: string; name: string };
}

type PostFields = { title?: string; body?: string; is_anonymous?: boolean; type?: string; url?: string; [key: string]: unknown };

export async function createPost(agent: Agent, community: string, fields: PostFields = {}) {
    const title = fields.title ?? `Post ${Math.random().toString(36).slice(2, 8)}`;
    const response = await agent.post('/v1/posts').send({ community, body: 'body', ...fields, title });
    if (response.status !== 201) throw new Error(`Post create failed: ${JSON.stringify(response.body)}`);
    return response.body.post as { id: string; short_id: string; title: string };
}

type CommentFields = { body?: string; is_anonymous?: boolean; parent_id?: string; [key: string]: unknown };

export async function createComment(agent: Agent, postId: string, fields: CommentFields = {}) {
    const response = await agent.post(`/v1/posts/${postId}/comments`).send({ body: 'comment', ...fields });
    if (response.status !== 201) throw new Error(`Comment create failed: ${JSON.stringify(response.body)}`);
    return response.body.comment as { id: string; short_id: string; body: string };
}

export async function makeModerator(userId: string, communityId: string) {
    return prisma.communityMember.upsert({
        where: { community_id_user_id: { community_id: communityId, user_id: userId } },
        create: { community_id: communityId, user_id: userId, role: 'moderator' },
        update: { role: 'moderator' },
    });
}

// The token from the newest dev-outbox email sent to an address
export function lastEmailToken(to: string) {
    const email = [...devOutbox].reverse().find((item) => item.to === to);
    const match = email?.text.match(/token=([\w-]+)/);
    if (!match) throw new Error(`No email with a token for ${to}`);
    return match[1];
}

export const cookieValue = (response: request.Response, name: string) => {
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    const cookie = cookies.find((value) => value.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.split(';')[0].slice(name.length + 1)) : undefined;
};
