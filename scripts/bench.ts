import request from 'supertest';
import app from '../src/app';
import prisma from '../src/prismaConnection';

// Times the hot paths in-process (server time only, no network) against whatever DATABASE_URL points at.
// Run after `npm run seed:bench`:  DATABASE_URL=... RATE_LIMIT_STORE=memory npm run bench

const RUNS = 30;

async function time(label: string, path: string) {
    await request(app).get(path); // warm up
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
        const started = process.hrtime.bigint();
        const response = await request(app).get(path);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
    }
    samples.sort((a, b) => a - b);
    const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].toFixed(1);
    console.log(`${label.padEnd(36)} p50 ${p(0.5).padStart(6)} ms   p95 ${p(0.95).padStart(6)} ms`);
}

async function main() {
    const [posts, comments] = await Promise.all([prisma.post.count(), prisma.comment.count()]);
    console.log(`Dataset: ${posts} posts, ${comments} comments\n`);

    const biggest = await prisma.post.findFirstOrThrow({ orderBy: { comment_count: 'desc' }, include: { community: true } });
    const community = biggest.community.name;
    console.log(`Largest thread: ${biggest.comment_count} comments\n`);

    await time('global feed, hot', '/v1/feed?sort=hot&limit=25');
    await time('global feed, new, page 5', await deepCursor('/v1/feed?sort=new&limit=25', 4));
    await time('global feed, top this week', '/v1/feed?sort=top&t=week&limit=25');
    await time('community feed, hot', `/v1/communities/${community}/posts?sort=hot&limit=25`);
    await time('post detail', `/v1/posts/${biggest.short_id}`);
    await time('thread page (largest thread)', `/v1/posts/${biggest.short_id}/comments?sort=best&limit=20&depth=3&replies=3`);
    await time('thread page 2 (largest thread)', await deepCursor(`/v1/posts/${biggest.short_id}/comments?sort=best&limit=20&depth=3&replies=3`, 1));
    await time('legacy post page (largest thread)', `/community/${community}/replies/${biggest.short_id}`);
    await time('search', '/v1/search?q=fuel%20prices');
}

// Follows next_cursor a few pages deep and returns that URL
async function deepCursor(path: string, pages: number) {
    let url = path;
    for (let i = 0; i < pages; i++) {
        const response = await request(app).get(url);
        url = `${path}&cursor=${response.body.next_cursor}`;
    }
    return url;
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
