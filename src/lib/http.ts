import { Request } from 'express';
import { z, ZodError } from 'zod';

// Thrown from routes and services; the error handler turns it into a JSON response.
export class HttpError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public fields?: Record<string, string>
    ) {
        super(message);
    }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'You are not allowed to do that.', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new HttpError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);

export function validationError(error: ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
        const key = issue.path.join('.') || '_';
        fields[key] ??= issue.message;
    }
    const first = error.issues[0];
    const message = first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input';
    return new HttpError(400, 'validation_failed', message, fields);
}

// Parses input with a zod schema, throwing a 400 with per-field messages on failure
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const result = schema.safeParse(input ?? {});
    if (!result.success) throw validationError(result.error);
    return result.data;
}

export const isV1 = (request: Request) => request.originalUrl.startsWith('/v1');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A path parameter that must be a UUID; anything else is simply not found
export function uuidParam(value: unknown, what = 'Not found') {
    if (typeof value !== 'string' || !UUID.test(value)) throw notFound(what);
    return value;
}
