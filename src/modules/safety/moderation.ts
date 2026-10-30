import { env } from '../../config/env';
import logger from '../../lib/logger';

// Automatic content checks with OpenAI's moderation endpoint (omni-moderation-latest: free, text and pictures).
// The site's rule: no porn or explicit sexual content anywhere, NSFW communities included. "NSFW" here only means
// mature (graphic news, sexual health, strong language). So:
//   - sexual content involving minors: blocked outright, held for the admins with a warning, never published;
//   - sexual content: held for the admins (community moderators can't approve it);
//   - severe violence, self-harm intent or instructions, threats: held for the community's moderators;
//   - graphic violence or self-harm talk short of that: published, with the mature (NSFW) label added.
// It fails open: with no OPENAI_API_KEY, or when the service is slow or down, content publishes as before and a
// log line says so. The other filters (modules/safety/filters.ts) still apply either way.

const ENDPOINT = 'https://api.openai.com/v1/moderations';
const TIMEOUT_MS = 4_000;

export type ModerationScores = Record<string, number>;

export type Verdict =
    | { action: 'publish' }
    | { action: 'label_mature'; reason: string }
    | { action: 'hold'; reason: string }
    | { action: 'hold_for_admins'; reason: string };

let warnedNoKey = false;

// Category scores (0 to 1) for some text and pictures, or null when the check couldn't run
export async function moderationScores(input: { text?: string; imageUrls?: string[] }): Promise<ModerationScores | null> {
    const text = input.text?.trim();
    // Public https addresses (OpenAI fetches them) or inline pictures (data:image/...), e.g. an upload before it's stored
    const images = (input.imageUrls ?? []).filter((url) => url.startsWith('https://') || url.startsWith('data:image/'));
    if (!text && images.length === 0) return null;
    if (!env.OPENAI_API_KEY) {
        if (!warnedNoKey) logger.warn('OPENAI_API_KEY is not set, so posts, comments and pictures are not checked automatically');
        warnedNoKey = true;
        return null;
    }
    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'omni-moderation-latest',
                input: [
                    ...(text ? [{ type: 'text', text: text.slice(0, 20_000) }] : []),
                    ...images.slice(0, 1).map((url) => ({ type: 'image_url', image_url: { url } })),
                ],
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            logger.warn({ status: response.status }, 'Moderation check failed; publishing without it');
            return null;
        }
        const data = (await response.json()) as { results?: { category_scores?: ModerationScores }[] };
        return data.results?.[0]?.category_scores ?? null;
    } catch (error) {
        logger.warn({ err: error }, 'Moderation check unavailable; publishing without it');
        return null;
    }
}

// What to do with content, from its scores. Thresholds lean towards holding for a person rather than deciding alone.
export function judge(scores: ModerationScores | null): Verdict {
    if (!scores) return { action: 'publish' };
    const score = (category: string) => scores[category] ?? 0;

    if (score('sexual/minors') >= 0.2) {
        return { action: 'hold_for_admins', reason: 'Possible sexual content involving a minor. Do not approve: remove it, and report it if confirmed.' };
    }
    if (score('sexual') >= 0.5) return { action: 'hold_for_admins', reason: 'Sexual content (not allowed anywhere on the site)' };

    if (score('violence/graphic') >= 0.9) return { action: 'hold', reason: 'Very graphic violence' };
    if (score('self-harm/instructions') >= 0.5) return { action: 'hold', reason: 'Self-harm instructions' };
    if (score('self-harm/intent') >= 0.7) return { action: 'hold', reason: 'Someone may be at risk of harming themselves' };
    if (score('harassment/threatening') >= 0.8 || score('hate/threatening') >= 0.7) return { action: 'hold', reason: 'Threatening language' };
    if (score('illicit/violent') >= 0.8) return { action: 'hold', reason: 'Instructions for violence' };

    if (score('violence/graphic') >= 0.5) return { action: 'label_mature', reason: 'Graphic violence' };
    if (score('self-harm') >= 0.5) return { action: 'label_mature', reason: 'Talks about self-harm' };
    return { action: 'publish' };
}

export async function checkContent(input: { text?: string; imageUrls?: string[] }): Promise<Verdict> {
    return judge(await moderationScores(input));
}
