import request from 'supertest';
import app from '../src/app';
import prisma from '../src/prismaConnection';

export const api = () => request(app);

const PASSWORD = 'Passw0rd!Passw0rd';

// Signs up a user and returns an agent that carries their auth cookies
export async function signUp(username: string) {
    const agent = request.agent(app);
    const response = await agent
        .post('/auth/signup')
        .send({ email: `${username}@example.test`, username, password: PASSWORD });
    if (response.status !== 200) {
        throw new Error(`Signup failed for ${username}: ${JSON.stringify(response.body)}`);
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });
    return { agent, user, password: PASSWORD };
}

export async function createCommunity(agent: ReturnType<typeof request.agent>, name: string) {
    const response = await agent.post('/community/create-community').send({ name, description: 'test' });
    if (response.status !== 200) {
        throw new Error(`Community create failed: ${JSON.stringify(response.body)}`);
    }
    return response.body.community as { id: string; name: string };
}

export async function createPost(
    agent: ReturnType<typeof request.agent>,
    communityId: string,
    fields: { title?: string; content?: string; is_anonymous?: boolean; is_sponsored?: boolean } = {}
) {
    const title = fields.title ?? `Post ${Math.random().toString(36).slice(2, 8)}`;
    const response = await agent
        .post('/post/create-post')
        .send({ community_id: communityId, content: 'body', ...fields, title });
    if (response.status !== 200) {
        throw new Error(`Post create failed: ${JSON.stringify(response.body)}`);
    }
    return prisma.post.findFirstOrThrow({ where: { title } });
}

export async function createComment(
    agent: ReturnType<typeof request.agent>,
    postId: string,
    fields: { content?: string; is_anonymous?: boolean; parent_comment_id?: string; is_sponsored?: boolean } = {}
) {
    const response = await agent.post('/comment/create').send({ post_id: postId, content: 'comment', ...fields });
    if (response.status !== 200) {
        throw new Error(`Comment create failed: ${JSON.stringify(response.body)}`);
    }
    return response.body.comment as { id: string; short_id: string };
}

export async function makeModerator(userId: string, communityId: string) {
    return prisma.moderator.create({ data: { user_id: userId, community_id: communityId } });
}
