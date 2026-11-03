import prisma from '../../prismaConnection';
import logger from '../../lib/logger';
import { mediaBase, oldMediaBases, storageDriver } from '../../lib/storage';

// Uploaded images are stored as full addresses (R2_PUBLIC_URL + key), so moving the bucket to another public address
// (the r2.dev one to media.yarnter.com, say) means rewriting the start of every stored address. The files themselves
// don't move: the keys stay the same. Runs on boot for each address in R2_OLD_PUBLIC_URLS, and by hand through
// scripts/media-rebase.ts.

// Every column that holds an uploaded image's address. `json` columns hold addresses inside a JSON value.
const MEDIA_COLUMNS = [
    { table: 'Community', column: 'image_url' },
    { table: 'Community', column: 'banner_url' },
    { table: 'Advertiser', column: 'logo_url' },
    { table: 'AdCreative', column: 'image_url' },
    { table: 'AdCreative', column: 'link_image_url' },
    { table: 'Post', column: 'image', json: true },
] as const;

const base = (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Not a web address: ${url}`);
    return url.replace(/\/+$/, '');
};

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

// Counts (and with apply, rewrites) addresses starting with `from` so they start with `to` instead
export async function rebaseMediaUrls(from: string, to: string, apply: boolean) {
    const oldBase = `${base(from)}/`;
    const newBase = `${base(to)}/`;
    if (oldBase === newBase) throw new Error('The old and new addresses are the same');

    const counts: Record<string, number> = {};
    await prisma.$transaction(async (tx) => {
        // Table and column names come from the fixed list above, never from input
        for (const entry of MEDIA_COLUMNS) {
            const { table, column } = entry;
            // Plain columns must start with the old base; in JSON the address starts right after a quote. Either way a
            // look-alike host such as pub-abc.r2.dev.evil.test doesn't match, because the base ends with "/".
            const [where, set, args] =
                'json' in entry
                    ? [
                          `"${column}"::text LIKE '%' || $1 || '%'`,
                          `"${column}" = replace("${column}"::text, $2::text, $3::text)::jsonb`,
                          [likeEscape(`"${oldBase}`), `"${oldBase}`, `"${newBase}`],
                      ]
                    : [
                          `"${column}" LIKE $1 || '%'`,
                          `"${column}" = $2::text || substr("${column}", $3::int)`,
                          [likeEscape(oldBase), newBase, oldBase.length + 1],
                      ];
            counts[`${table}.${column}`] = apply
                ? await tx.$executeRawUnsafe(`UPDATE "${table}" SET ${set} WHERE ${where}`, ...args)
                : Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`, args[0]))[0].n);
        }
    });
    return counts;
}

// On boot: stored addresses on any old bucket address move to the current one. Nothing to do costs one quick query per
// column, so it's safe to leave R2_OLD_PUBLIC_URLS set.
export async function rebaseOldMediaUrls() {
    if (storageDriver() !== 'r2') return;
    for (const old of oldMediaBases()) {
        const counts = await rebaseMediaUrls(old, mediaBase(), true);
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        if (total > 0) logger.info({ from: old, to: mediaBase(), counts }, 'Moved stored image addresses to the current bucket address');
    }
}
