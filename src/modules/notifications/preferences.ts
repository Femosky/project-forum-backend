import { User } from '@prisma/client';
import { z } from 'zod';

// What someone wants to hear about (User.notification_preferences). Missing values mean these defaults.
export const preferencesSchema = z.object({
    email_replies: z.boolean().default(true),
    email_mentions: z.boolean().default(true),
    digest: z.enum(['weekly', 'daily', 'off']).default('weekly'),
    push_replies: z.boolean().default(true),
    push_trending: z.boolean().default(true),
    digest_hidden: z.array(z.string().max(40)).max(200).default([]),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export function preferencesOf(user: Pick<User, 'notification_preferences'>): Preferences {
    const parsed = preferencesSchema.safeParse(user.notification_preferences ?? {});
    return parsed.success ? parsed.data : preferencesSchema.parse({});
}
