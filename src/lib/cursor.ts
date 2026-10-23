import { badRequest } from './http';

// Keyset pagination. A cursor is the sort value and id of the last item on the previous page,
// base64url-encoded so clients treat it as opaque.

export type SortValue = number | string | Date;
type Encoded = { v: number | string; d?: 1; id: string };

export function encodeCursor(value: SortValue, id: string): string {
    const payload: Encoded = value instanceof Date ? { v: value.toISOString(), d: 1, id } : { v: value, id };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { value: SortValue; id: string } | null {
    if (!cursor) return null;
    try {
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Encoded;
        if (typeof payload.id !== 'string' || (typeof payload.v !== 'number' && typeof payload.v !== 'string')) {
            throw new Error('bad cursor');
        }
        return { value: payload.d ? new Date(payload.v) : payload.v, id: payload.id };
    } catch {
        throw badRequest('Invalid cursor', 'invalid_cursor');
    }
}

// Prisma where-clause for "rows after the cursor" when ordering by (field, id) in one direction
export function afterCursor(field: string, direction: 'asc' | 'desc', cursor: { value: SortValue; id: string } | null) {
    if (!cursor) return {};
    const op = direction === 'desc' ? 'lt' : 'gt';
    return {
        OR: [{ [field]: { [op]: cursor.value } }, { [field]: cursor.value, id: { [op]: cursor.id } }],
    };
}

// Takes limit + 1 rows, returns the page and the cursor for the next one
export function paginate<T extends { id: string }>(rows: T[], limit: number, field: keyof T) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const next_cursor = hasMore && last ? encodeCursor(last[field] as SortValue, last.id) : null;
    return { items, next_cursor };
}
