import { customAlphabet } from 'nanoid';
import { Prisma } from '@prisma/client';

// 8 chars of base36 is ~2.8e12 ids; collisions are caught by the unique index and retried.
export const newShortId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

// Routes accept either the UUID or the short id
export const idOrShortId = (value: string) => (isUuid(value) ? { id: value } : { short_id: value.toLowerCase() });

// Runs a create that uses a fresh short id, retrying if the id is already taken
export async function withShortIdRetry<T>(create: (shortId: string) => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await create(newShortId());
        } catch (error) {
            const isCollision =
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002' &&
                String(error.meta?.target ?? '').includes('short_id');
            if (!isCollision || attempt >= attempts) throw error;
        }
    }
}
