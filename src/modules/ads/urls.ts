import { isIP } from 'node:net';
import { env } from '../../config/env';
import { isPublicAddress } from '../../lib/linkPreview';

// Ad destinations. An ad can point at a page on this site ("/communities", or a full link to WEB_URL) or at an
// advertiser's site. Links to this site are stored as given and resolved against WEB_URL when served, so a house ad
// never carries a hard-coded host. A link to localhost or a private address can only come from a local test, so it
// is treated as a path on this site too: it shows the site's name and redirects to the same page on WEB_URL.

export function isLocalHost(hostname: string) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
    return isIP(host) !== 0 && !isPublicAddress(host);
}

// The path (with query and fragment) when the destination is on this site, else null
export function onSitePath(destination: string): string | null {
    if (destination.startsWith('/') && !destination.startsWith('//')) return destination;
    try {
        const url = new URL(destination);
        const site = new URL(env.WEB_URL);
        if (url.host === site.host || isLocalHost(url.hostname)) return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        // Not a URL
    }
    return null;
}

// Where a click should land
export function resolveDestination(destination: string) {
    const path = onSitePath(destination);
    return path === null ? destination : `${env.WEB_URL}${path}`;
}

// Why an advertiser-facing link is unacceptable, or null when it's fine. In production, links must be https and
// public (no localhost, private addresses or .local names); site paths starting with / are fine anywhere.
export function linkProblem(value: string, { allowSitePath }: { allowSitePath: boolean }): string | null {
    if (value.startsWith('/') && !value.startsWith('//')) return allowSitePath ? null : 'Use a full link, starting with https://';
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return allowSitePath ? 'Use a full https:// link, or a page on this site starting with /' : 'Use a full https:// link';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an http or https link';
    if (!env.IS_PRODUCTION) return null;
    if (url.protocol !== 'https:') return 'Use an https:// link';
    if (isLocalHost(url.hostname)) return "That link only works on someone's own computer. Use a public https:// link.";
    return null;
}
