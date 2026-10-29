import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/lib/cursor';
import { isPublicAddress, parsePreview } from '../src/lib/linkPreview';
import { hotRank, wilsonLowerBound } from '../src/lib/ranking';
import { PostgresStore } from '../src/lib/rateLimit';
import { slugify } from '../src/lib/slug';

describe('ranking', () => {
    it('gives newer posts a higher hot rank and 10x votes the same lift as 12.5 hours', () => {
        const now = new Date('2026-10-23T12:00:00Z');
        const earlier = new Date(now.getTime() - 12.5 * 60 * 60 * 1000);
        expect(hotRank(0, now)).toBeGreaterThan(hotRank(0, earlier));
        expect(hotRank(10, earlier)).toBeCloseTo(hotRank(1, now), 5);
        expect(hotRank(-10, now)).toBeLessThan(hotRank(0, now));
    });

    it('counts replies at half a vote each, still log-scaled, and keeps the old two-argument call', () => {
        const now = new Date('2026-10-23T12:00:00Z');
        expect(hotRank(5, now)).toBe(hotRank(5, now, 0));
        expect(hotRank(0, now, 20)).toBeCloseTo(hotRank(10, now), 7);
        expect(hotRank(0, now, 4)).toBeGreaterThan(hotRank(0, now));
        // A downvoted post people are arguing under climbs back
        expect(hotRank(-3, now, 10)).toBeGreaterThan(hotRank(-3, now));
        expect(hotRank(10, now, 180)).toBeCloseTo(hotRank(1, now, 18) + 1, 5);
    });

    it('prefers many upvotes over a lucky single one for "best"', () => {
        expect(wilsonLowerBound(0, 0)).toBe(0);
        expect(wilsonLowerBound(30, 2)).toBeGreaterThan(wilsonLowerBound(1, 0));
        expect(wilsonLowerBound(5, 5)).toBeLessThan(wilsonLowerBound(9, 1));
    });
});

describe('slugify', () => {
    it('keeps URLs ascii, short and never empty', () => {
        expect(slugify('Where can I buy Ọ̀fadà rice in Lagos?')).toBe('where-can-i-buy-ofada-rice-in-lagos');
        expect(slugify('🔥🔥🔥')).toBe('post');
        expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(80);
    });
});

describe('cursors', () => {
    it('round-trips numbers and dates, and rejects junk', () => {
        const date = new Date('2026-10-23T10:00:00.123Z');
        expect(decodeCursor(encodeCursor(date, 'abc'))).toEqual({ value: date, id: 'abc' });
        expect(decodeCursor(encodeCursor(12.3456789, 'x'))).toEqual({ value: 12.3456789, id: 'x' });
        expect(() => decodeCursor('not-json')).toThrow();
    });
});

describe('link previews', () => {
    it('refuses private and loopback addresses', () => {
        for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
            expect(isPublicAddress(address)).toBe(false);
        }
        expect(isPublicAddress('102.89.33.10')).toBe(true);
        expect(isPublicAddress('2606:4700::1111')).toBe(true);
    });

    it('reads Open Graph tags and resolves relative images', () => {
        const html = `<html><head><title>Fallback</title>
            <meta property="og:title" content="Fuel price rises again &amp; queues return">
            <meta content="Long queues in Abuja." name="description">
            <meta property="og:image" content="/img/queue.jpg">
            <meta property="og:site_name" content="Daily News"></head></html>`;
        expect(parsePreview(html, new URL('https://news.example/story'))).toEqual({
            title: 'Fuel price rises again & queues return',
            description: 'Long queues in Abuja.',
            image: 'https://news.example/img/queue.jpg',
            site: 'Daily News',
        });
        expect(parsePreview('<title>Only a title</title>', new URL('https://www.example.com/')).site).toBe('example.com');
    });
});

describe('Postgres rate-limit store', () => {
    it('counts hits per key within the window and resets', async () => {
        const store = new PostgresStore('test');
        store.init({ windowMs: 60_000 } as never);

        expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
        expect((await store.increment('1.2.3.4')).totalHits).toBe(2);
        expect((await store.increment('5.6.7.8')).totalHits).toBe(1);
        expect((await store.get('1.2.3.4'))?.totalHits).toBe(2);

        await store.decrement('1.2.3.4');
        expect((await store.get('1.2.3.4'))?.totalHits).toBe(1);
        await store.resetKey('1.2.3.4');
        expect(await store.get('1.2.3.4')).toBeUndefined();
    });

    it('starts a fresh window once the old one has expired', async () => {
        const store = new PostgresStore('test');
        store.init({ windowMs: 1 } as never);
        await store.increment('k');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect((await store.increment('k')).totalHits).toBe(1);
    });
});
