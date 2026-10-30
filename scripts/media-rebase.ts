// Points stored image addresses at a new public address for the R2 bucket (modules/images/rebase.ts), for example
// after moving from the r2.dev address to media.forum.oskeylabs.com. Set R2_PUBLIC_URL to the new address first.
//
//   npm run media:rebase -- --from=https://pub-xxxx.r2.dev            (dry run: counts only)
//   npm run media:rebase -- --from=https://pub-xxxx.r2.dev --apply    (rewrites them)
import { env } from '../src/config/env';
import prisma from '../src/prismaConnection';
import { rebaseMediaUrls } from '../src/modules/images/rebase';

(async () => {
    const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
    const to = env.R2_PUBLIC_URL;
    if (!from || !to) {
        console.error('Usage: npm run media:rebase -- --from=<old public address> [--apply]   (R2_PUBLIC_URL must be the new one)');
        process.exit(1);
    }
    const apply = process.argv.includes('--apply');
    const counts = await rebaseMediaUrls(from, to, apply);
    console.log(`${apply ? 'Rewrote' : 'Would rewrite'} addresses from ${from} to ${to}:`, counts);
    if (!apply) console.log('Nothing changed. Add --apply to rewrite them.');
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
});
