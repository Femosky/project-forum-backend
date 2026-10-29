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

// "a3k0..." one base-36 character per part, in AVATAR_PARTS order. Null when the account never chose one: the web
// app then derives the avatar from the username, so everyone looks different without anything stored.
export function avatarCode(config: Prisma.JsonValue | null | undefined): string | null {
    const parsed = avatarConfigSchema.safeParse(config);
    return parsed.success ? PARTS.map((part) => parsed.data[part].toString(36)).join('') : null;
}
