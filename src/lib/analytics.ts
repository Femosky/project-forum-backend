import { env } from '../config/env';
import logger from './logger';

// Product analytics (PostHog, EU cloud), sent from the server so the web app ships no tracking script and sets no
// cookies. Without POSTHOG_API_KEY nothing leaves the process. Events carry no content, no post or comment ids and
// nothing that could tie an anonymous post back to its author: only the event name, the account id and a few
// coarse properties.

export type AnalyticsEvent =
    | 'signup'
    | 'user_active'
    | 'post_created'
    | 'comment_created'
    | 'vote'
    | 'search';

type Captured = { event: AnalyticsEvent; distinct_id: string; properties: Record<string, unknown>; timestamp: string };

// Guests have no stable id and get no person profile in PostHog
export const GUEST_ID = 'guest';

const FLUSH_EVERY_MS = 10_000;
const MAX_BATCH = 50;

let queue: Captured[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

// Tests read what would have been sent
export const sentForTests: Captured[] = [];

export function track(event: AnalyticsEvent, userId: string | undefined, properties: Record<string, unknown> = {}) {
    const captured: Captured = {
        event,
        distinct_id: userId ?? GUEST_ID,
        properties: userId ? properties : { ...properties, $process_person_profile: false },
        timestamp: new Date().toISOString(),
    };
    if (env.IS_TEST) {
        sentForTests.push(captured);
        return;
    }
    if (!env.POSTHOG_API_KEY) return;

    queue.push(captured);
    if (queue.length >= MAX_BATCH) void flushAnalytics();
    else if (!timer) timer = setTimeout(() => void flushAnalytics(), FLUSH_EVERY_MS);
}

// One "user_active" per account per day is enough for return-visit (D1/D7/D30) retention
const activeToday = new Set<string>();
let activeDay = '';

export function trackActive(userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== activeDay) {
        activeDay = today;
        activeToday.clear();
    }
    if (activeToday.has(userId)) return;
    activeToday.add(userId);
    track('user_active', userId);
}

export async function flushAnalytics() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!queue.length || !env.POSTHOG_API_KEY) return;
    const batch = queue;
    queue = [];

    try {
        const response = await fetch(`${env.POSTHOG_HOST.replace(/\/$/, '')}/batch/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, batch }),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) logger.warn({ status: response.status, events: batch.length }, 'Analytics batch rejected');
    } catch (error) {
        // Analytics is best effort: a lost batch never affects the request that caused it
        logger.warn({ err: error, events: batch.length }, 'Analytics batch failed');
    }
}
