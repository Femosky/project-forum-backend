import { Request, Response, NextFunction } from 'express';
import { ErrorResponse } from '../models/interfaces/errorType';

// Logs the real error server-side and returns a generic message; internals never reach the client.
export function sendServerError(response: Response, message: string, error: unknown) {
    console.error(`[${response.req.method} ${response.req.originalUrl}] ${message}:`, error);
    return response.status(500).json({ error: message } as ErrorResponse);
}

export function notFoundHandler(request: Request, response: Response) {
    return response.status(404).json({ error: 'Not found' } as ErrorResponse);
}

// Catches anything a route throws without handling (Express 5 forwards rejected promises here).
export function errorHandler(error: unknown, request: Request, response: Response, next: NextFunction) {
    if (response.headersSent) {
        return next(error);
    }

    // Malformed JSON bodies come from express.json() as a 400
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
        return response.status(400).json({ error: 'Invalid JSON body' } as ErrorResponse);
    }

    return sendServerError(response, 'Something went wrong', error);
}
