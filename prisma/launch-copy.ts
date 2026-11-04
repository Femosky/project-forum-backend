import prisma from '../src/prismaConnection';
import { slugify } from '../src/lib/slug';
import { LAUNCH_COMMUNITIES } from './launch/content';

// Brings already-seeded launch content up to date with the titles and community descriptions in prisma/launch/,
// without touching anything else (votes, replies, dates and ids stay as they are).
//
//   npm run seed:launch-copy                         show what would change, change nothing
//   npm run seed:launch-copy -- --confirm=<db host>  apply the changes
//
// A seeded thread is found by its community, its seed author and its body, so a re-run is safe and threads that
// people have edited since are left alone. Old post addresses keep working: posts load by short id and redirect
// to the new slug.

function option(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
    const url = new URL(process.env.DATABASE_URL ?? '');
    const host = url.hostname;
    const apply = option('confirm') === host;
    console.log(`Database: ${host}${url.pathname} (${apply ? 'applying' : 'dry run, add --confirm=' + host + ' to apply'})`);

    let communitiesChanged = 0;
    let postsChanged = 0;
    let missing = 0;

    for (const data of LAUNCH_COMMUNITIES) {
        const community = await prisma.community.findUnique({ where: { name: data.name.toLowerCase() }, select: { id: true, description: true } });
        if (!community) {
            console.log(`  skip c/${data.name}: not in this database`);
            missing += 1 + data.threads.length;
            continue;
        }
        if (community.description !== data.description) {
            console.log(`  c/${data.name} description:\n      ${data.description}`);
            if (apply) await prisma.community.update({ where: { id: community.id }, data: { description: data.description } });
            communitiesChanged += 1;
        }

        for (const thread of data.threads) {
            const post = await prisma.post.findFirst({
                where: { community_id: community.id, body: thread.body, author: { username: thread.by } },
                select: { id: true, title: true, slug: true },
            });
            if (!post) {
                console.log(`  skip "${thread.title}": no matching seeded post (edited or removed)`);
                missing += 1;
                continue;
            }
            const slug = slugify(thread.title);
            if (post.title === thread.title && post.slug === slug) continue;
            console.log(`  "${post.title}"\n   -> "${thread.title}"`);
            if (apply) await prisma.post.update({ where: { id: post.id }, data: { title: thread.title, slug } });
            postsChanged += 1;
        }
    }

    console.log(
        `${apply ? 'Updated' : 'Would update'} ${communitiesChanged} community descriptions and ${postsChanged} post titles` +
            (missing ? `; ${missing} not found` : '') +
            '.'
    );
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
