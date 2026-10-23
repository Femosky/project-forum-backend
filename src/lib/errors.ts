import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { HttpError, isV1, validationError } from './http';

// /v1 errors look like { error: { code, message, fields? } }. The legacy routes keep { error: message }.
function send(request: Request, response: Response, error: HttpError) {
    if (isV1(request)) {
        return response.status(error.status).json({
            error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) },
        });
    }
    return response.status(error.status).json({ error: error.message });
}

export function notFoundHandler(request: Request, response: Response) {
    return send(request, response, new HttpError(404, 'not_found', 'Not found'));
}

// Catches everything a route throws (Express 5 forwards rejected promises here). Internals are logged, never returned.
export function errorHandler(error: unknown, request: Request, response: Response, next: NextFunction) {
    if (response.headersSent) return next(error);

    if (error instanceof HttpError) return send(request, response, error);
    if (error instanceof ZodError) return send(request, response, validationError(error));

    // Malformed JSON bodies come from express.json() as a 400
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
        return send(request, response, new HttpError(400, 'invalid_json', 'Invalid JSON body'));
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
        return send(request, response, new HttpError(413, 'payload_too_large', 'Request body is too large'));
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return send(request, response, new HttpError(404, 'not_found', 'Not found'));
    }

    request.log?.error({ err: error }, 'Unhandled error');
    return send(request, response, new HttpError(500, 'internal', 'Something went wrong'));
}
