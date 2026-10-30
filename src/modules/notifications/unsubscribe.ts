import { Request, Response, Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { readEmailToken } from '../../lib/emailTokens';
import { badRequest, parse } from '../../lib/http';
import { preferencesOf, Preferences } from './preferences';

// From a link or a mail app's one-click unsubscribe, so no sign-in; the signed token says who and what.
// The token comes in the query (List-Unsubscribe) or the body (the /unsubscribe page).

const router = Router();

const schema = z.object({ token: z.string().min(10).max(400) });

const CHANGES: Partial<Record<string, (preferences: Preferences, ref?: string) => Partial<Preferences>>> = {
    replies: () => ({ email_replies: false }),
    mentions: () => ({ email_mentions: false }),
    digest: () => ({ digest: 'off' }),
    hide: (preferences, ref) => ({ digest_hidden: [...new Set([...preferences.digest_hidden, ref ?? ''])].slice(-200) }),
};

const LABELS: Record<string, string> = { replies: 'reply emails', mentions: 'mention emails', digest: 'digest emails' };

async function unsubscribe(request: Request, response: Response) {
    const { token } = parse(schema, { token: request.query.token ?? request.body?.token });
    const action = readEmailToken(token);
    if (!action) throw badRequest('This link is invalid.', 'invalid_token');

    if (action.kind === 'mod' && action.ref) {
        const community = await prisma.community.findUnique({ where: { id: action.ref }, select: { name: true } });
        if (!community) throw badRequest('This link is invalid.', 'invalid_token');
        await prisma.modEmailSetting.upsert({
            where: { community_id_user_id: { community_id: action.ref, user_id: action.userId } },
            create: { community_id: action.ref, user_id: action.userId, frequency: 'off' },
            update: { frequency: 'off' },
        });
        return response.json({ done: `moderator emails for c/${community.name}` });
    }

    const change = CHANGES[action.kind];
    const user = change ? await prisma.user.findUnique({ where: { id: action.userId } }) : null;
    if (!change || !user) throw badRequest('This link is invalid.', 'invalid_token');
    const preferences = preferencesOf(user);
    await prisma.user.update({ where: { id: user.id }, data: { notification_preferences: { ...preferences, ...change(preferences, action.ref) } } });
    response.json({ done: action.kind === 'hide' ? `c/${action.ref} in your digest` : LABELS[action.kind] });
}

router.post('/unsubscribe', unsubscribe);

export default router;
