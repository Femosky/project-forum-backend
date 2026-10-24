import * as bcrypt from 'bcrypt';
import prisma from '../src/prismaConnection';

// Two seeds:
//   npm run seed           a handful of users, communities and posts for local development
//   npm run seed:bench     a large synthetic dataset for performance checks (SEED_POSTS, SEED_COMMENTS)
// Every seeded account's password is "password123".

const PASSWORD = 'password123';

// Wilson lower bound (80%) over the "ups" and "downs" columns of a CTE, matching src/lib/ranking.ts
const WILSON_SQL = `CASE WHEN ups + downs = 0 THEN 0 ELSE
    ((ups::float / (ups + downs)) + 1.642374 / (2 * (ups + downs))
     - 1.281551565545 * sqrt(((ups::float / (ups + downs)) * (1 - ups::float / (ups + downs)) + 1.642374 / (4 * (ups + downs))) / (ups + downs)))
    / (1 + 1.642374 / (ups + downs)) END`;

async function devSeed() {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const users = await Promise.all(
        ['femi', 'tolu', 'tosin'].map((username) =>
            prisma.user.upsert({
                where: { username },
                create: {
                    username,
                    email: `${username}@example.test`,
                    password_hash: passwordHash,
                    email_verified_at: new Date(),
                    adult_attested_at: new Date(),
                    // A month old, so new-account limits don't get in the way of trying things out
                    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                    // femi can open /admin
                    role: username === 'femi' ? 'admin' : 'user',
                },
                update: {},
            })
        )
    );

    const communities = [
        { name: 'lagos_rent', category: 'housing', description: 'Renting, agents, landlords and house hunting in Lagos.' },
        { name: 'naija_tech', category: 'tech', description: 'Jobs, tools and building tech in and from Nigeria.' },
        { name: 'japa', category: 'relocation', description: 'Moving abroad: visas, schools, jobs and settling in.' },
        { name: 'diaspora_home', category: 'other', description: 'Staying connected to home from London, Houston, Toronto and everywhere else.' },
    ];
    for (const [index, data] of communities.entries()) {
        const owner = users[index % users.length];
        const community = await prisma.community.upsert({
            where: { name: data.name },
            create: { ...data, created_by: owner.id, member_count: users.length },
            update: { category: data.category },
        });
        for (const user of users) {
            await prisma.communityMember.upsert({
                where: { community_id_user_id: { community_id: community.id, user_id: user.id } },
                create: { community_id: community.id, user_id: user.id, role: user.id === owner.id ? 'owner' : 'member' },
                update: {},
            });
        }
    }
    console.log(`Dev seed done. Sign in as femi, tolu or tosin with "${PASSWORD}". Create posts through the API.`);
}

async function benchSeed() {
    const posts = Number(process.env.SEED_POSTS ?? 100_000);
    const comments = Number(process.env.SEED_COMMENTS ?? 1_000_000);
    const users = 2_000;
    const communities = 50;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const run = (label: string, sql: string) => {
        const started = Date.now();
        return prisma.$executeRawUnsafe(sql).then((count) => console.log(`${label}: ${count} rows in ${Date.now() - started} ms`));
    };

    await run(
        'users',
        `INSERT INTO "User" ("id", "username", "email", "password_hash", "adult_attested_at", "updated_at")
         SELECT gen_random_uuid(), 'bench_user_' || i, 'bench_user_' || i || '@example.test', '${passwordHash}', now(), now()
         FROM generate_series(1, ${users}) AS i`
    );
    await run(
        'communities',
        `INSERT INTO "Community" ("id", "name", "description", "created_by", "member_count", "updated_at")
         SELECT gen_random_uuid(), 'bench_' || i, 'Benchmark community ' || i,
                (SELECT "id" FROM "User" WHERE "username" = 'bench_user_1'), 0, now()
         FROM generate_series(1, ${communities}) AS i`
    );
    await run(
        'members',
        `INSERT INTO "CommunityMember" ("community_id", "user_id")
         SELECT c."id", u."id" FROM "Community" c JOIN "User" u ON random() < 0.1
         WHERE c."name" LIKE 'bench_%' AND u."username" LIKE 'bench_user_%'`
    );

    // Posts spread over 90 days with a long-tailed score; hot_rank uses the same formula as src/lib/ranking.ts
    await run(
        'posts',
        `WITH u AS (SELECT array_agg("id") AS ids FROM "User" WHERE "username" LIKE 'bench_user_%'),
              c AS (SELECT array_agg("id") AS ids FROM "Community" WHERE "name" LIKE 'bench_%'),
              raw AS (
                SELECT i, now() - (random() * interval '90 days') AS created_at,
                       floor(power(random(), 6) * 2000)::int AS ups, floor(random() * 20)::int AS downs
                FROM generate_series(1, ${posts}) AS i)
         INSERT INTO "Post" ("id", "short_id", "slug", "author_id", "community_id", "title", "body", "created_at", "updated_at",
                             "upvote_count", "downvote_count", "score", "hot_rank")
         SELECT gen_random_uuid(), 'p' || lpad(to_hex(i), 7, '0'), 'benchmark-post-' || i,
                u.ids[1 + (i % ${users})], c.ids[1 + (i % ${communities})],
                'Benchmark post ' || i || ' about rent, jobs and fuel prices',
                repeat('Lorem ipsum dolor sit amet. ', 20), created_at, created_at, ups, downs, ups - downs,
                sign(ups - downs) * log(greatest(abs(ups - downs), 1)) + (extract(epoch from created_at) - 1134028003) / 45000
         FROM raw, u, c`
    );

    // Comment trees: 40% top level, then three more levels, each reply under a random comment of the level above.
    // A few posts get very large threads (every 500th post takes a big share), like real hot threads.
    const levels = [0.4, 0.3, 0.2, 0.1].map((share) => Math.floor(comments * share));
    let offset = 0;
    for (const [level, count] of levels.entries()) {
        const start = offset + 1;
        const end = offset + count;
        if (level === 0) {
            await run(
                'comments level 0',
                `WITH u AS (SELECT array_agg("id") AS ids FROM "User" WHERE "username" LIKE 'bench_user_%'),
                      raw AS (SELECT i, floor(power(random(), 4) * 200)::int AS ups, floor(random() * 5)::int AS downs
                              FROM generate_series(${start}, ${end}) AS i)
                 INSERT INTO "Comment" ("id", "short_id", "post_id", "author_id", "depth", "path", "body", "created_at", "updated_at",
                                        "upvote_count", "downvote_count", "score", "best_rank")
                 SELECT gen_random_uuid(), 'c' || lpad(to_hex(i), 7, '0'), p."id", u.ids[1 + (i % ${users})], 0,
                        'c' || lpad(to_hex(i), 7, '0'), 'Benchmark comment ' || i, p."created_at" + interval '1 hour', now(),
                        ups, downs, ups - downs, ${WILSON_SQL}
                 FROM raw
                 JOIN "Post" p ON p."short_id" = 'p' || lpad(to_hex(
                     CASE WHEN i % 4 = 0 THEN 1 + (i % ${Math.max(Math.floor(posts / 500), 1)}) * 500 ELSE 1 + (i % ${posts}) END
                 ), 7, '0'), u`
            );
        } else {
            const previousStart = start - levels[level - 1];
            await run(
                `comments level ${level}`,
                `WITH u AS (SELECT array_agg("id") AS ids FROM "User" WHERE "username" LIKE 'bench_user_%'),
                      raw AS (SELECT i, floor(power(random(), 4) * 100)::int AS ups, floor(random() * 5)::int AS downs
                              FROM generate_series(${start}, ${end}) AS i)
                 INSERT INTO "Comment" ("id", "short_id", "post_id", "author_id", "parent_id", "root_id", "depth", "path", "body",
                                        "created_at", "updated_at", "upvote_count", "downvote_count", "score", "best_rank")
                 SELECT gen_random_uuid(), 'c' || lpad(to_hex(i), 7, '0'), parent."post_id", u.ids[1 + (i % ${users})], parent."id",
                        coalesce(parent."root_id", parent."id"), parent."depth" + 1, parent."path" || '/c' || lpad(to_hex(i), 7, '0'),
                        'Benchmark reply ' || i, parent."created_at" + interval '1 hour', now(), ups, downs, ups - downs, ${WILSON_SQL}
                 FROM raw
                 JOIN "Comment" parent ON parent."short_id" = 'c' || lpad(to_hex(${previousStart} + (i::bigint * 7919) % ${levels[level - 1]}), 7, '0'), u`
            );
        }
        offset = end;
    }

    await run(
        'reply counts',
        `UPDATE "Comment" c SET "reply_count" = r.n FROM (SELECT "parent_id", count(*) AS n FROM "Comment" WHERE "parent_id" IS NOT NULL GROUP BY 1) r
         WHERE c."id" = r."parent_id"`
    );
    await run(
        'post comment counts',
        `UPDATE "Post" p SET "comment_count" = r.n FROM (SELECT "post_id", count(*) AS n FROM "Comment" GROUP BY 1) r WHERE p."id" = r."post_id"`
    );
    await run(
        'community counts',
        `UPDATE "Community" c SET "post_count" = (SELECT count(*) FROM "Post" WHERE "community_id" = c."id"),
                                  "member_count" = (SELECT count(*) FROM "CommunityMember" WHERE "community_id" = c."id")
         WHERE c."name" LIKE 'bench_%'`
    );
    await run('analyze', 'ANALYZE');
}

const main = process.argv.includes('--bench') ? benchSeed : devSeed;

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
