import { z } from 'zod';

// Limits and field schemas shared by every module. Written with no server imports so they can move into a
// shared package for the web app's forms later.

export const LIMITS = {
    TITLE_MIN: 3,
    TITLE_MAX: 300,
    POST_BODY_MAX: 40_000,
    COMMENT_MAX: 10_000,
    COMMUNITY_NAME_MIN: 3,
    COMMUNITY_NAME_MAX: 21,
    COMMUNITY_DESCRIPTION_MAX: 500,
    USERNAME_MIN: 3,
    USERNAME_MAX: 20,
    PASSWORD_MIN: 10,
    PASSWORD_MAX: 128,
    DISPLAY_NAME_MAX: 30,
    URL_MAX: 2048,
    REPORT_NOTE_MAX: 1000,
    REASON_MAX: 500,
    PAGE_SIZE_MAX: 100,
} as const;

export const username = z
    .string()
    .trim()
    .toLowerCase()
    .min(LIMITS.USERNAME_MIN)
    .max(LIMITS.USERNAME_MAX)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use letters, numbers and underscores, starting with a letter');

// A new community's name as typed: letters and digits, starting with a letter. It's stored lowercase as the URL key
// (premierleague) and as typed as the styled handle (PremierLeague).
export const communityName = z
    .string()
    .trim()
    .min(LIMITS.COMMUNITY_NAME_MIN)
    .max(LIMITS.COMMUNITY_NAME_MAX)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'Use letters and numbers only, starting with a letter');

// A reference to an existing community, in any case, including names from before underscores were dropped
// (lagos_rent finds LagosRent through its alias)
export const communityRef = z
    .string()
    .trim()
    .min(LIMITS.COMMUNITY_NAME_MIN)
    .max(40)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Not a community name');

export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const password = z
    .string()
    .min(LIMITS.PASSWORD_MIN, `Use at least ${LIMITS.PASSWORD_MIN} characters`)
    .max(LIMITS.PASSWORD_MAX, `Use at most ${LIMITS.PASSWORD_MAX} characters`);

export const title = z.string().trim().min(LIMITS.TITLE_MIN).max(LIMITS.TITLE_MAX);
export const postBody = z.string().trim().max(LIMITS.POST_BODY_MAX);
export const commentBody = z.string().trim().min(1, 'Write something first').max(LIMITS.COMMENT_MAX);

export const httpUrl = z
    .string()
    .trim()
    .max(LIMITS.URL_MAX)
    .pipe(z.url({ protocol: /^https?$/ }));

export const voteValue = z.union([z.literal(1), z.literal(0), z.literal(-1)]);

export const pageQuery = z.object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_SIZE_MAX).default(25),
});

// Directory categories. The key is stored on the community; the label is what people see.
export const COMMUNITY_CATEGORIES = {
    careers: 'Jobs & Careers',
    tech: 'Tech & Startups',
    relocation: 'Relocation & Visas',
    education: 'Schools & Education',
    housing: 'Rent & Housing',
    money: 'Money & Banking',
    business: 'Small Business',
    cars: 'Cars',
    health: 'Health',
    relationships: 'Relationships',
    sports: 'Sports',
    food: 'Food',
    entertainment: 'Entertainment',
    other: 'Other',
} as const;

export type CommunityCategory = keyof typeof COMMUNITY_CATEGORIES;
export const communityCategory = z.enum(Object.keys(COMMUNITY_CATEGORIES) as [CommunityCategory, ...CommunityCategory[]]);

export const postSort = z.enum(['hot', 'new', 'top']).default('hot');
export const topWindow = z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).default('day');
export const commentSort = z.enum(['best', 'top', 'new', 'old']).default('best');
