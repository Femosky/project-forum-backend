// Where a post view came from, as one of a fixed set of labels. The browser sends only the referring site's host
// (never the full address); it's matched here and dropped, so no address is ever stored.

const SOURCES: [RegExp, string][] = [
    [/(^|\.)google\./, 'Google'],
    [/(^|\.)bing\.com$/, 'Bing'],
    [/(^|\.)(duckduckgo\.com|search\.yahoo\.com|yandex\.|ecosia\.org|search\.brave\.com)/, 'Other search'],
    [/(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/, 'AI assistants'],
    [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'Facebook'],
    [/(^|\.)(instagram\.com)$/, 'Instagram'],
    [/(^|\.)(x\.com|twitter\.com|t\.co)$/, 'X'],
    [/(^|\.)(whatsapp\.com|wa\.me)$/, 'WhatsApp'],
    [/(^|\.)(telegram\.org|t\.me)$/, 'Telegram'],
    [/(^|\.)(reddit\.com|redd\.it)$/, 'Reddit'],
    [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'LinkedIn'],
    [/(^|\.)(tiktok\.com)$/, 'TikTok'],
    [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
    [/(^|\.)(nairaland\.com)$/, 'Nairaland'],
];

export const SOURCE_LABELS = ['Direct', 'Yarnter', ...new Set(SOURCES.map(([, label]) => label)), 'Other sites'];

// ownHosts: the web app's own hosts (a click from another Yarnter page)
export function sourceOf(referrerHost: string | undefined, ownHosts: string[]) {
    const host = referrerHost?.trim().toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    if (!host) return 'Direct';
    if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) return 'Yarnter';
    // Android apps send android-app://<package> as the referrer; the browser passes on just the package name
    if (host.startsWith('com.google.android.')) return 'Google';
    return SOURCES.find(([pattern]) => pattern.test(host))?.[1] ?? 'Other sites';
}
