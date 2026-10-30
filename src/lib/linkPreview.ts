import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type LinkPreview = { title?: string; description?: string; image?: string; site?: string };

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

// Private, loopback, link-local and other non-public ranges. The fetcher refuses them so a post's link
// can't be used to probe the API's own network.
export function isPublicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
        return true;
    }
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice(7));
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')) return false;
    return true;
}

async function assertSafeUrl(url: URL) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Unsupported port');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
        throw new Error('Refusing to fetch a non-public address');
    }
}

const decode = (value: string) =>
    value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/\s+/g, ' ')
        .trim();

function metaContent(html: string, key: string): string | undefined {
    const patterns = [
        new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return decode(match[1]);
    }
    return undefined;
}

// Pulls Open Graph / basic meta tags out of an HTML document
export function parsePreview(html: string, pageUrl: URL): LinkPreview {
    const head = html.slice(0, MAX_BYTES);
    const title = metaContent(head, 'og:title') ?? metaContent(head, 'twitter:title') ?? head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    const description = metaContent(head, 'og:description') ?? metaContent(head, 'description');
    let image = metaContent(head, 'og:image') ?? metaContent(head, 'twitter:image');
    if (image) {
        try {
            const resolved = new URL(image, pageUrl);
            image = resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.toString() : undefined;
        } catch {
            image = undefined;
        }
    }
    const site = metaContent(head, 'og:site_name') ?? pageUrl.hostname.replace(/^www\./, '');

    const clip = (value: string | undefined, max: number) => (value ? decode(value).slice(0, max) || undefined : undefined);
    return { title: clip(title, 300), description: clip(description, 500), image: clip(image, 2048), site: clip(site, 100) };
}

// Fetches a page with redirects checked hop by hop, a 5 s timeout and a 512 KB cap
export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertSafeUrl(url);
        const response = await fetch(url, {
            redirect: 'manual',
            headers: { 'User-Agent': 'ProjectForumBot/1.0 (+link preview)', Accept: 'text/html' },
            signal: AbortSignal.timeout(5_000),
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) return null;
            url = new URL(location, url);
            continue;
        }
        if (!response.ok || !response.body) return null;
        if (!(response.headers.get('content-type') ?? '').includes('html')) return null;

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size < MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
        }
        await reader.cancel().catch(() => undefined);
        return parsePreview(Buffer.concat(chunks).toString('utf8'), url);
    }
    return null;
}

// Downloads a picture from a public address (the same checks as pages: public hosts only, redirects checked hop by
// hop, 5 s), up to maxBytes. Null when it isn't a picture or is too big.
export async function fetchPublicImage(rawUrl: string, maxBytes: number): Promise<Buffer | null> {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertSafeUrl(url);
        const response = await fetch(url, {
            redirect: 'manual',
            headers: { 'User-Agent': 'ProjectForumBot/1.0 (+link preview)', Accept: 'image/*' },
            signal: AbortSignal.timeout(5_000),
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) return null;
            url = new URL(location, url);
            continue;
        }
        if (!response.ok || !response.body) return null;
        if (!(response.headers.get('content-type') ?? '').startsWith('image/')) return null;
        if (Number(response.headers.get('content-length') ?? 0) > maxBytes) return null;

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(value);
        }
        return Buffer.concat(chunks);
    }
    return null;
}
