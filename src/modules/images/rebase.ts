import prisma from '../../prismaConnection';

// Uploaded images are stored as full addresses (R2_PUBLIC_URL + key), so moving the bucket to another public address
// (the r2.dev one to media.forum.oskeylabs.com, say) means rewriting the start of every stored address. The files
// themselves don't move: the keys stay the same. Run through scripts/media-rebase.ts.

// Every column that holds an uploaded image's address
const MEDIA_COLUMNS = [
    { table: 'Community', column: 'image_url' },
    { table: 'Community', column: 'banner_url' },
    { table: 'Advertiser', column: 'logo_url' },
    { table: 'AdCreative', column: 'image_url' },
] as const;

const base = (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Not a web address: ${url}`);
    return url.replace(/\/+$/, '');
};

// Counts (and with apply, rewrites) addresses starting with `from` so they start with `to` instead
export async function rebaseMediaUrls(from: string, to: string, apply: boolean) {
    const oldBase = `${base(from)}/`;
    const newBase = `${base(to)}/`;
    if (oldBase === newBase) throw new Error('The old and new addresses are the same');

    const counts: Record<string, number> = {};
    await prisma.$transaction(async (tx) => {
        for (const { table, column } of MEDIA_COLUMNS) {
            // Table and column names come from the fixed list above, never from input
            const where = `"${column}" LIKE $1 || '%'`;
            const pattern = oldBase.replace(/[\\%_]/g, (character) => `\\${character}`);
            counts[`${table}.${column}`] = apply
                ? await tx.$executeRawUnsafe(
                      `UPDATE "${table}" SET "${column}" = $2 || substr("${column}", $3) WHERE ${where}`,
                      pattern,
                      newBase,
                      oldBase.length + 1
                  )
                : Number(
                      (await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`, pattern))[0].n
                  );
        }
    });
    return counts;
}
