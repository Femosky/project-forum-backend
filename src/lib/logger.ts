import pino from 'pino';
import { env } from '../config/env';

// Structured JSON logs. Cookies, auth headers and passwords never reach the log.
export const logger = pino({
    level: env.IS_TEST ? 'silent' : env.LOG_LEVEL,
    redact: {
        paths: [
            'req.headers.cookie',
            'req.headers.authorization',
            'res.headers["set-cookie"]',
            '*.password',
            '*.token',
            '*.id_token',
        ],
        censor: '[redacted]',
    },
});

export default logger;
