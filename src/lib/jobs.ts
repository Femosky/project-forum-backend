import PgBoss from 'pg-boss';
import { env } from '../config/env';
import logger from './logger';

// Background jobs on Postgres (pg-boss), so there is no extra infrastructure to pay for.
// With JOBS_ENABLED=false (tests, or a tiny deploy) jobs run inline instead of being queued.

type Handler<T> = (data: T) => Promise<void>;
type JobOptions = { retryLimit?: number; retryDelay?: number; retryBackoff?: boolean; singletonKey?: string };

const handlers = new Map<string, { handler: Handler<any>; options: JobOptions }>();
let boss: PgBoss | null = null;

export function defineJob<T extends object>(name: string, handler: Handler<T>, options: JobOptions = {}) {
    handlers.set(name, { handler, options });
    return {
        name,
        enqueue: (data: T) => enqueue(name, data),
    };
}

async function enqueue(name: string, data: object) {
    const job = handlers.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);

    if (!boss) {
        try {
            await job.handler(data);
        } catch (error) {
            logger.error({ err: error, job: name }, 'Inline job failed');
        }
        return;
    }
    await boss.send(name, data, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...job.options });
}

export async function startJobs() {
    if (!env.JOBS_ENABLED) return;
    boss = new PgBoss({ connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL, max: 3 });
    boss.on('error', (error) => logger.error({ err: error }, 'Job queue error'));
    await boss.start();

    for (const [name, { handler }] of handlers) {
        await boss.createQueue(name);
        await boss.work(name, async (jobs) => {
            for (const job of jobs) await handler(job.data);
        });
    }
    logger.info({ jobs: [...handlers.keys()] }, 'Job queue started');
}

export async function stopJobs() {
    await boss?.stop({ graceful: true });
    boss = null;
}
