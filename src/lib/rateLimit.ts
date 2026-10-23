import { Request } from 'express';
import { ipKeyGenerator, MemoryStore, Options, rateLimit, Store } from 'express-rate-limit';
import { env } from '../config/env';
import prisma from '../prismaConnection';
import { AuthRequest } from '../middlewares/auth';

// express-rate-limit store backed by the RateLimit table: one upsert per counted request. Limits then hold across
// several API instances without Redis. Expired rows are swept now and then.
export class PostgresStore implements Store {
    windowMs = 60_000;
    localKeys = false;

    constructor(public prefix: string) {}

    init(options: Options) {
        this.windowMs = options.windowMs;
    }

    private key(key: string) {
        return `${this.prefix}:${key}`;
    }

    async get(key: string) {
        const row = await prisma.rateLimit.findUnique({ where: { key: this.key(key) } });
        if (!row || row.reset_at <= new Date()) return undefined;
        return { totalHits: row.hits, resetTime: row.reset_at };
    }

    async increment(key: string) {
        // "now" comes from the app, not the database, so the timestamp(3) column is never compared across time zones
        const now = new Date();
        const resetAt = new Date(now.getTime() + this.windowMs);
        const [row] = await prisma.$queryRaw<{ hits: number; reset_at: Date }[]>`
            INSERT INTO "RateLimit" ("key", "hits", "reset_at") VALUES (${this.key(key)}, 1, ${resetAt})
            ON CONFLICT ("key") DO UPDATE SET
                "hits" = CASE WHEN "RateLimit"."reset_at" <= ${now} THEN 1 ELSE "RateLimit"."hits" + 1 END,
                "reset_at" = CASE WHEN "RateLimit"."reset_at" <= ${now} THEN EXCLUDED."reset_at" ELSE "RateLimit"."reset_at" END
            RETURNING "hits", "reset_at"`;
        if (Math.random() < 0.01) {
            void prisma.rateLimit.deleteMany({ where: { reset_at: { lt: new Date() } } }).catch(() => undefined);
        }
        return { totalHits: row.hits, resetTime: row.reset_at };
    }

    async decrement(key: string) {
        await prisma.rateLimit.updateMany({ where: { key: this.key(key), hits: { gt: 0 } }, data: { hits: { decrement: 1 } } });
    }

    async resetKey(key: string) {
        await prisma.rateLimit.deleteMany({ where: { key: this.key(key) } });
    }
}

export type CounterStore = Required<Pick<Store, 'get' | 'increment' | 'resetKey'>>;

// A store for one limiter. Each limiter needs its own store (and prefix).
export function createStore(prefix: string, windowMs: number): Store & CounterStore {
    const store = env.RATE_LIMIT_STORE === 'postgres' ? new PostgresStore(prefix) : new MemoryStore();
    store.init?.({ windowMs } as Options);
    return store as Store & CounterStore;
}

// Signed-in users are limited per account, everyone else per IP (IPv6 grouped by /56)
export const userOrIpKey = (request: Request) => {
    const user = (request as AuthRequest).viewer?.user;
    return user ? `user:${user.id}` : `ip:${ipKeyGenerator(request.ip ?? '')}`;
};

type LimiterOptions = { name: string; windowMs: number; limit: number; message: string; skipGet?: boolean; store?: Store };

export function limiter({ name, windowMs, limit, message, skipGet, store }: LimiterOptions) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        keyGenerator: userOrIpKey,
        store: store ?? createStore(name, windowMs),
        skip: (request) => env.IS_TEST || (skipGet === true && request.method === 'GET'),
        handler: (request, response) => {
            response.status(429).json({ error: { code: 'rate_limited', message } });
        },
    });
}
