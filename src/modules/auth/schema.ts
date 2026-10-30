import { z } from 'zod';
import { email, password, username } from '../../shared/validation';

const turnstile = z.string().max(4096).optional();

export const signupSchema = z.object({
    email,
    username,
    password,
    // 18+ only at launch (roadmap decision 10)
    is_adult: z.literal(true, { error: 'You must be 18 or older to join' }),
    turnstile_token: turnstile,
});

// Accepts { identifier } or the older { email } / { username } fields
export const loginSchema = z
    .object({
        identifier: z.string().trim().min(1).max(254).optional(),
        email: z.string().trim().min(1).max(254).optional(),
        username: z.string().trim().min(1).max(254).optional(),
        password: z.string().min(1).max(256),
        turnstile_token: turnstile,
    })
    .transform(({ identifier, email, username, ...rest }) => ({ ...rest, identifier: identifier ?? email ?? username }))
    .refine((value) => Boolean(value.identifier), { message: 'Email or username is required', path: ['identifier'] });

export const tokenSchema = z.object({ token: z.string().min(10).max(200) });

export const forgotPasswordSchema = z.object({ email, turnstile_token: turnstile });

export const resetPasswordSchema = z.object({ token: z.string().min(10).max(200), password });

export const changePasswordSchema = z.object({ current_password: z.string().max(256).optional(), new_password: password });

export const changeEmailSchema = z.object({ new_email: email, password: z.string().min(1).max(256) });

export const googleSchema = z.object({
    id_token: z.string().min(10).max(8192),
    // Both required the first time a Google user joins: the username they picked and the 18+ confirmation
    username: username.optional(),
    is_adult: z.literal(true).optional(),
});

export const googleLinkSchema = z.object({ id_token: z.string().min(10).max(8192) });
