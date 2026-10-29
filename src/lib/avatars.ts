import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

// Drawn avatars instead of profile photos (by decision: anonymity, and no storage of people's faces). An avatar is a
// choice from each set of hand-drawn parts; the web app holds the drawings (frontend src/avatars) and renders them
// as SVG. Here: how many options each part has, validation, and a compact code for URLs.
//
// The order and counts must match the web app's parts. New options go at the end of a list, never in the middle,
// so existing avatars keep their look.
export const AVATAR_PARTS = {
    face: 4,
    skin: 10,
    eyes: 8,
    mouth: 6,
    hair: 12,
    hair_colour: 8,
    accessory: 6,
    outfit: 8,
    background: 8,
} as const;

export type AvatarPart = keyof typeof AVATAR_PARTS;
export type AvatarConfig = Record<AvatarPart, number>;
const PARTS = Object.keys(AVATAR_PARTS) as AvatarPart[];

export const avatarConfigSchema = z.object(
    Object.fromEntries(PARTS.map((part) => [part, z.number().int().min(0).max(AVATAR_PARTS[part] - 1)])) as Record<
        AvatarPart,
        z.ZodNumber
    >
);

export const randomAvatar = (): AvatarConfig =>
    Object.fromEntries(PARTS.map((part) => [part, randomInt(AVATAR_PARTS[part])])) as AvatarConfig;

const encode = (config: AvatarConfig) => PARTS.map((part) => config[part].toString(36)).join('');

// The same picture for a username every time, for accounts that never chose one: FNV-1a, then one slice of the
// hash per part. The web app's avatars/code.ts has the same function; keep them in step.
export function avatarFromName(name: string): AvatarConfig {
    let hash = 2166136261;
    for (const char of name.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const config = {} as AvatarConfig;
    for (const part of PARTS) {
        config[part] = hash % AVATAR_PARTS[part];
        hash = Math.imul(hash ^ (hash >>> 13), 2654435761) >>> 0;
    }
    return config;
}

// "a3k0..." one base-36 character per part, in AVATAR_PARTS order: what the web app draws at /avatar/{code}.svg.
// Accounts that never chose get the one derived from their username, so everyone looks different by default.
export function avatarCode(config: Prisma.JsonValue | null | undefined, username: string): string {
    const parsed = avatarConfigSchema.safeParse(config);
    return encode(parsed.success ? parsed.data : avatarFromName(username));
}
