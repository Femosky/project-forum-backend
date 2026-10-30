import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Request } from 'express';
import maxmind, { CountryResponse, Reader } from 'maxmind';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import logger from '../../lib/logger';

// Privacy-safe unique visitors without a cookie: the id is sha256(day's salt, IP, user agent). Each Lagos day gets
// a fresh random salt (stored so every API instance agrees, deleted after two days by the nightly stats job), so
// ids can't be linked across days and nobody can recompute one later. The IP itself is never stored.

const salts = new Map<string, string>();

async function saltFor(day: string) {
    const cached = salts.get(day);
    if (cached) return cached;
    await prisma.$executeRaw`
        INSERT INTO "DailySalt" ("date", "salt") VALUES (${day}::date, ${randomBytes(32).toString('hex')})
        ON CONFLICT ("date") DO NOTHING`;
    // A new day: salts older than yesterday have no use left, so they go (the nightly stats job does this too)
    await prisma.$executeRaw`DELETE FROM "DailySalt" WHERE "date" < ${day}::date - 1`;
    const [row] = await prisma.$queryRaw<{ salt: string }[]>`SELECT "salt" FROM "DailySalt" WHERE "date" = ${day}::date`;
    if (salts.size > 4) salts.clear();
    salts.set(day, row.salt);
    return row.salt;
}

export async function visitorId(day: string, ip: string, userAgent: string) {
    const salt = await saltFor(day);
    return createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('base64url').slice(0, 22);
}

// Country, when it's cheap to know: a CDN's country header if the request came through one, else the free
// GeoLite2-Country database when it's been dropped into src/dependencies (or GEOIP_COUNTRY_DB points at it).
// Neither: null, and the stats just show "unknown".
let reader: Reader<CountryResponse> | null | undefined;

async function countryReader() {
    if (reader !== undefined) return reader;
    const file = env.GEOIP_COUNTRY_DB ?? path.join(__dirname, '../../dependencies/GeoLite2-Country.mmdb');
    try {
        reader = existsSync(file) ? await maxmind.open<CountryResponse>(file) : null;
    } catch (error) {
        logger.warn({ err: error }, 'GeoLite2-Country database could not be opened');
        reader = null;
    }
    return reader;
}

const COUNTRY_CODE = /^[A-Z]{2}$/;

export async function countryOf(request: Request): Promise<string | null> {
    for (const header of ['x-vercel-ip-country', 'cf-ipcountry']) {
        const value = request.get(header)?.toUpperCase();
        if (value && COUNTRY_CODE.test(value) && value !== 'XX') return value;
    }
    const ip = request.ip;
    const db = ip ? await countryReader() : null;
    if (!db || !ip || !maxmind.validate(ip)) return null;
    return db.get(ip)?.country?.iso_code ?? null;
}
