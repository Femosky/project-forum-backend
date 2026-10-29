import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// A small pool: hosted Postgres free tiers allow few connections, shared with the job queue's 3. Idle connections are
// closed after 10 seconds (pg's default) and nothing is sent on them meanwhile, so an idle API lets Neon suspend.
// DATABASE_POOL_SIZE raises it on bigger plans.
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_SIZE) || 5,
});
export const prisma = new PrismaClient({ adapter });

export default prisma;
