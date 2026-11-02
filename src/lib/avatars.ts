import { Prisma } from '@prisma/client';
import { z } from 'zod';

// Drawn avatars instead of profile photos (by decision: anonymity, and no storage of people's faces). The web app holds
// the drawings (frontend src/avatars); here an avatar is only a set of named parts, like { hair: 'nok-topknot' }.
//
// Parts are stored by name, never by position, and this file does not list the options: a new hairstyle or thread
// style only needs adding in the web app, and an option it no longer knows falls back to its default when drawn.
export const AVATAR_PARTS = [
    'starter',
    'skin',
    'hair',
    'hair_colour',
    'top',
    'cloth',
    'neck',
    'eyewear',
    'eyes',
    'mouth',
    'beard',
    'background',
    'thread',
    'thread_style',
] as const;

export type AvatarPart = (typeof AVATAR_PARTS)[number];
export type AvatarConfig = Partial<Record<AvatarPart, string>>;

const optionName = z.string().regex(/^[a-z0-9-]{1,24}$/);

export const avatarConfigSchema = z
    .strictObject(Object.fromEntries(AVATAR_PARTS.map((part) => [part, optionName.optional()])) as Record<AvatarPart, z.ZodOptional<typeof optionName>>)
    .refine((config) => Object.keys(config).length > 0);

// A number that stays the same for a username: the web app turns it into one of the starter avatars
function starterNumber(name: string): string {
    let hash = 2166136261;
    for (const char of name.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return hash.toString(36);
}

// The starter shown on anonymous posts and comments. It comes from the person and the post together, so one post's
// picture says nothing about their other posts, and it can't be matched to the starter on their profile.
export const anonymousAvatarCode = (authorId: string, postId: string) => `s-${starterNumber(`${authorId}:${postId}`)}`;

// What the web app draws at /avatar/{code}.svg. "y1_hair-afro_skin-sienna" for chosen parts, in AVATAR_PARTS order;
// "s-1a2b3c" for accounts that never chose, and for avatars saved before parts had names.
export function avatarCode(config: Prisma.JsonValue | null | undefined, username: string): string {
    const parsed = avatarConfigSchema.safeParse(config);
    if (!parsed.success) return `s-${starterNumber(username)}`;
    return ['y1', ...AVATAR_PARTS.flatMap((part) => (parsed.data[part] ? [`${part}-${parsed.data[part]}`] : []))].join('_');
}
