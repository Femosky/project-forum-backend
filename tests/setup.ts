import { beforeEach, afterAll } from 'vitest';
import prisma from '../src/prismaConnection';
import { assertLocalDatabase } from './globalSetup';
import { resetMetricsForTests } from '../src/modules/metrics/buffer';
import { resetTrendingForTests } from '../src/modules/trending/service';

assertLocalDatabase(process.env.DATABASE_URL as string);

beforeEach(async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    // In-memory buffers and caches start empty too
    resetMetricsForTests();
    resetTrendingForTests();
});

afterAll(async () => {
    await prisma.$disconnect();
});
