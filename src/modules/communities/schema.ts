import { z } from 'zod';
import { isStoredMedia } from '../../lib/storage';
import { communityCategory, communityName, LIMITS, pageQuery, postSort, topWindow, username } from '../../shared/validation';

const rules = z
    .array(z.object({ title: z.string().trim().min(1).max(100), description: z.string().trim().max(500).default('') }))
    .max(15);

// A topic icon the web app draws itself
const DEFAULT_ICON = /^\/community-icon\/[a-z]+-[a-z]+\.svg$/;

export const createCommunitySchema = z.object({
    name: communityName,
    display_name: z.string().trim().max(50).optional(),
    description: z.string().trim().max(LIMITS.COMMUNITY_DESCRIPTION_MAX).optional(),
    visibility: z.enum(['public', 'private']).default('public'),
    is_nsfw: z.boolean().default(false),
    rules: rules.optional(),
    category: communityCategory.optional(),
});

export const updateCommunitySchema = z
    .object({
        display_name: z.string().trim().max(50).nullable().optional(),
        // The handle's capitals ("PremierLeague"); must be the community's name with only the case changed
        name_styled: z.string().trim().max(LIMITS.COMMUNITY_NAME_MAX).nullable().optional(),
        description: z.string().trim().max(LIMITS.COMMUNITY_DESCRIPTION_MAX).nullable().optional(),
        // Icon and banner: uploaded through POST /v1/images, so they're our own stored files
        image_url: z.string().trim().max(LIMITS.URL_MAX).refine((url) => isStoredMedia(url) || DEFAULT_ICON.test(url), 'Upload the picture first').nullable().optional(),
        banner_url: z.string().trim().max(LIMITS.URL_MAX).refine(isStoredMedia, 'Upload the picture first').nullable().optional(),
        visibility: z.enum(['public', 'private']).optional(),
        is_nsfw: z.boolean().optional(),
        rules: rules.optional(),
        category: communityCategory.nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listCommunitiesQuery = pageQuery.extend({
    sort: z.enum(['popular', 'new']).default('popular'),
    category: communityCategory.optional(),
    // Matches name, display name or description
    q: z.string().trim().min(1).max(50).optional(),
});

export const communityPostsQuery = pageQuery.extend({ sort: postSort, t: topWindow });

export const joinSchema = z.object({ message: z.string().trim().max(500).optional() });

export const joinDecisionSchema = z.object({ decision: z.enum(['accept', 'reject']) });

export const roleSchema = z.object({ role: z.enum(['member', 'moderator']) });

export const banSchema = z.object({
    username,
    // Omit for a permanent ban
    days: z.number().int().min(1).max(3650).optional(),
    reason: z.string().trim().max(LIMITS.REASON_MAX).optional(),
});

export const flairSchema = z.object({
    name: z.string().trim().min(1).max(32),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

// Names that would clash with app routes
export const RESERVED_NAMES = new Set([
    'admin', 'administrator', 'api', 'app', 'auth', 'c', 'categories', 'communities', 'community', 'create', 'feed', 'help',
    'home', 'login', 'logout', 'mod', 'moderator', 'new', 'popular', 'search', 'settings', 'signup', 'support',
    'top', 'u', 'user', 'users', 'www',
]);
