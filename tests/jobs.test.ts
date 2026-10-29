import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { defineJob, jobsState, noteActivity, onJobsWake, startJobs, stopJobs, suspendIfIdle } from '../src/lib/jobs';

// The job queue's idle suspend (lib/jobs.ts), against a real pg-boss on the test database
const original = { JOBS_ENABLED: env.JOBS_ENABLED, JOBS_IDLE_SUSPEND_MINUTES: env.JOBS_IDLE_SUSPEND_MINUTES };

afterEach(async () => {
    await stopJobs();
    Object.assign(env, original);
});

const MINUTE = 60_000;

async function until(check: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('Timed out');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

describe('job queue idle suspend', () => {
    it('stops after the idle time, and a job queued while idle starts it again and still runs', async () => {
        const done: string[] = [];
        const echo = defineJob<{ text: string }>('test.echo', async ({ text }) => {
            done.push(text);
        });
        let wakes = 0;
        onJobsWake('test.wake', async () => {
            wakes += 1;
        });
        Object.assign(env, { JOBS_ENABLED: true, JOBS_IDLE_SUSPEND_MINUTES: 5 });

        await startJobs();
        expect(jobsState()).toBe('running');
        await until(() => wakes === 1);

        // Not idle long enough yet
        expect(await suspendIfIdle(Date.now() + 4 * MINUTE)).toBe(false);
        expect(await suspendIfIdle(Date.now() + 6 * MINUTE)).toBe(true);
        expect(jobsState()).toBe('idle');

        // Queued while idle: the queue starts first, the job runs, and the wake hooks catch up
        await echo.enqueue({ text: 'hello' });
        expect(jobsState()).toBe('running');
        await until(() => done.includes('hello'));
        await until(() => wakes === 2);
    }, 30_000);

    it('starts again on the next request, and never suspends with the setting at 0', async () => {
        Object.assign(env, { JOBS_ENABLED: true, JOBS_IDLE_SUSPEND_MINUTES: 5 });
        await startJobs();
        await suspendIfIdle(Date.now() + 10 * MINUTE);
        expect(jobsState()).toBe('idle');

        noteActivity();
        await until(() => jobsState() === 'running');

        Object.assign(env, { JOBS_IDLE_SUSPEND_MINUTES: 0 });
        expect(await suspendIfIdle(Date.now() + 1000 * MINUTE)).toBe(false);
        expect(jobsState()).toBe('running');
    }, 30_000);

    it("doesn't count health checks as activity", async () => {
        const { api } = await import('./helpers');
        Object.assign(env, { JOBS_ENABLED: true, JOBS_IDLE_SUSPEND_MINUTES: 5 });
        await startJobs();
        await suspendIfIdle(Date.now() + 10 * MINUTE);
        await api().get('/v1/health').expect(200);
        expect(jobsState()).toBe('idle');
        await api().get('/v1/communities');
        expect(['starting', 'running']).toContain(jobsState());
    }, 30_000);
});
