import { openAiVerdict, strictest, Verdict } from './moderation';
import { judgeText } from './textCheck';
import { screenContent, ScreenInput } from './filters';

export type Review = {
    // Why it's held for review (status pending), or null to publish
    held_reason: string | null;
    // Only the site's admins may clear the hold
    held_for_admins: boolean;
    // Publish, but with the mature (NSFW) label
    mature: boolean;
};

// Every new or edited post and comment: the scam filters and the content checks (the site's own explicit-term check,
// plus OpenAI's when it's switched on), side by side. The content check wins when it holds something; otherwise the
// filters decide, and the check may still add the mature label.
export async function reviewContent(input: ScreenInput, also: Verdict[] = []): Promise<Review> {
    const text = [input.title, input.body, input.url].filter(Boolean).join('\n');
    const [filterReason, extra] = await Promise.all([screenContent(input), openAiVerdict({ text, imageUrls: input.imageUrls })]);
    // The site's own term check always runs, plus any verdicts the caller already has (a post's picture); OpenAI's only
    // adds to them when it's switched on
    const verdict = strictest(judgeText(text), extra, ...also);
    if (verdict.action === 'hold_for_admins') return { held_reason: verdict.reason, held_for_admins: true, mature: false };
    if (verdict.action === 'hold') return { held_reason: verdict.reason, held_for_admins: false, mature: false };
    return { held_reason: filterReason, held_for_admins: false, mature: verdict.action === 'label_mature' };
}
