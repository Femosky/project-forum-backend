import { env } from '../../config/env';
import { defineJob } from '../../lib/jobs';
import logger from '../../lib/logger';

// The web app's canonical path for a post
export function postPath(post: { short_id: string; slug: string; community: { name: string } }) {
    return `/c/${post.community.name}/${post.short_id}${post.slug ? `/${post.slug}` : ''}`;
}

// Tells IndexNow-enabled search engines (Bing, Yandex, Seznam, Naver) that pages are new or changed.
// One call reaches all of them. Skipped without INDEXNOW_KEY, in tests and for local web URLs.
export const indexNowJob = defineJob<{ paths: string[] }>(
    'seo.indexnow',
    async ({ paths }) => {
        if (!env.INDEXNOW_KEY || env.IS_TEST) return;
        const site = new URL(env.WEB_URL);
        if (site.hostname === 'localhost' || site.hostname === '127.0.0.1') return;

        const response = await fetch('https://api.indexnow.org/indexnow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
                host: site.host,
                key: env.INDEXNOW_KEY,
                keyLocation: `${env.WEB_URL}/indexnow-key.txt`,
                urlList: paths.map((path) => `${env.WEB_URL}${path}`),
            }),
            signal: AbortSignal.timeout(10_000),
        });
        // 200 and 202 both mean accepted; 4xx is a setup problem retries won't fix
        if (response.status >= 500) throw new Error(`IndexNow answered ${response.status}`);
        if (!response.ok) logger.warn({ status: response.status }, 'IndexNow rejected the ping');
    },
    { retryLimit: 2 }
);
