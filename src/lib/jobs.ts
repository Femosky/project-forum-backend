import PgBoss from 'pg-boss';
import { env } from '../config/env';
import logger from './logger';

// Background jobs on Postgres (pg-boss), so there is no extra infrastructure to pay for.
// With JOBS_ENABLED=false (tests, or a tiny deploy) jobs run inline instead of being queued.
//
// Idle suspend: pg-boss polls and does housekeeping all the time, which keeps a serverless database (Neon) awake and
// billed even when nobody is using the site. So when the API has had no requests for JOBS_IDLE_SUSPEND_MINUTES, the
// queue stops and the API sends the database nothing at all; the next request starts it again, and the "wake"
// hooks catch up on what the schedules missed meanwhile (a stale trending snapshot, missing daily stats). A job
// queued while idle starts the queue first, so it still runs. 0 turns this off, for when there is steady traffic.

type Handler<T> = (data: T) => Promise<void>;
type JobOptions = { retryLimit?: number; retryDelay?: number; retryBackoff?: boolean; singletonKey?: string };

const handlers = new Map<string, { handler: Handler<any>; options: JobOptions }>();
const schedules = new Map<string, { cron: string; tz: string }>();
const wakeHooks: { name: string; run: () => Promise<unknown> }[] = [];

// The queue: running (boss), starting, or not running (idle, or never wanted)
let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;
// startJobs() was called with JOBS_ENABLED: requests and jobs may (re)start the queue
let wanted = false;
let lastActivity = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;

// A queued email or link preview waits up to this long; scheduled jobs aren't affected
const POLLING_SECONDS = env.IS_TEST ? 1 : 10;
const IDLE_CHECK_MS = 30_000;

export function defineJob<T extends object>(name: string, handler: Handler<T>, options: JobOptions = {}) {
    handlers.set(name, { handler, options });
    return {
        name,
        enqueue: (data: T) => enqueue(name, data),
    };
}

// A job pg-boss runs on a cron schedule (one instance runs each tick, however many API processes there are).
// Without the queue (JOBS_ENABLED=false, or idle) nothing is scheduled, so callers that need fresh data also call
// run() when what they read is stale, and onJobsWake catches up after an idle spell; see modules/trending and
// modules/metrics.
export function defineScheduledJob(name: string, cron: string, handler: () => Promise<void>, options: { tz?: string } = {}) {
    handlers.set(name, { handler, options: { retryLimit: 1 } });
    schedules.set(name, { cron, tz: options.tz ?? 'Africa/Lagos' });
    return { name, run: handler };
}

// Runs (in the background) each time the queue starts: at boot and on waking from idle
export function onJobsWake(name: string, run: () => Promise<unknown>) {
    wakeHooks.push({ name, run });
}

async function boot(): Promise<PgBoss> {
    // Quiet even while running: housekeeping every 10 minutes, polling every 10 seconds
    const queue = new PgBoss({
        connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL,
        max: 3,
        maintenanceIntervalSeconds: 600,
        cronMonitorIntervalSeconds: 45,
        clockMonitorIntervalSeconds: 600,
    });
    queue.on('error', (error) => logger.error({ err: error }, 'Job queue error'));
    await queue.start();

    for (const [name, { handler }] of handlers) {
        await queue.createQueue(name);
        await queue.work(name, { pollingIntervalSeconds: POLLING_SECONDS }, async (jobs) => {
            for (const job of jobs) await handler(job.data);
        });
    }
    for (const [name, { cron, tz }] of schedules) {
        await queue.schedule(name, cron, {}, { tz, singletonKey: name });
    }
    logger.info({ jobs: [...handlers.keys()] }, 'Job queue started');

    for (const hook of wakeHooks) {
        void hook.run().catch((error) => logger.error({ err: error, hook: hook.name }, 'Job wake-up catch-up failed'));
    }
    return queue;
}

function ensureQueue(): Promise<PgBoss> {
    if (boss) return Promise.resolve(boss);
    starting ??= boot()
        .then((queue) => {
            boss = queue;
            return queue;
        })
        .finally(() => {
            starting = null;
        });
    return starting;
}

async function enqueue(name: string, data: object) {
    const job = handlers.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);

    let queue: PgBoss | null = null;
    if (wanted) {
        // An idle queue starts first, so the job isn't lost
        queue = await ensureQueue().catch((error) => {
            logger.error({ err: error, job: name }, 'Job queue unavailable; running the job inline');
            return null;
        });
    }
    if (!queue) {
        try {
            await job.handler(data);
        } catch (error) {
            logger.error({ err: error, job: name }, 'Inline job failed');
        }
        return;
    }
    await queue.send(name, data, { retryLimit: 3, retryDelay: 30, retryBackoff: true, ...job.options });
}

// A request came in (health checks don't count): the site is in use, so the queue should be running
export function noteActivity() {
    lastActivity = Date.now();
    if (wanted && !boss && !starting) {
        void ensureQueue().catch((error) => logger.error({ err: error }, 'Job queue failed to start again'));
    }
}

// Stops the queue when nothing has come in for a while. Exported for tests.
export async function suspendIfIdle(now = Date.now()) {
    const minutes = env.JOBS_IDLE_SUSPEND_MINUTES;
    if (!boss || starting || minutes <= 0 || now - lastActivity < minutes * 60_000) return false;
    const queue = boss;
    boss = null;
    await queue.stop({ graceful: true, wait: true });
    logger.info({ idleMinutes: minutes }, 'Job queue idle; stopped until the next request');
    return true;
}

export async function startJobs() {
    if (!env.JOBS_ENABLED) return;
    wanted = true;
    await ensureQueue();
    if (env.JOBS_IDLE_SUSPEND_MINUTES > 0 && !idleTimer) {
        idleTimer = setInterval(() => void suspendIfIdle().catch((error) => logger.error({ err: error }, 'Job queue suspend failed')), IDLE_CHECK_MS);
        // The timer alone never keeps the process alive
        idleTimer.unref();
    }
}

export async function stopJobs() {
    wanted = false;
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    const queue = boss ?? (starting ? await starting.catch(() => null) : null);
    boss = null;
    await queue?.stop({ graceful: true, wait: true });
}

// For tests: 'running', 'starting', 'idle' (wanted but stopped) or 'off'
export function jobsState() {
    return boss ? 'running' : starting ? 'starting' : wanted ? 'idle' : 'off';
}
