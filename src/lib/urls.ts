// A comparable form of a link: same page, different tracking or formatting, gives the same key.
// https://www.Example.com/a/?utm_source=x#top and https://example.com/a are both "example.com/a".
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|igshid|si|ref|ref_src)$/i;

export function urlKey(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const params = [...url.searchParams.entries()]
        .filter(([name]) => !TRACKING_PARAMS.test(name))
        .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params)}` : '';
    const path = url.pathname.replace(/\/+$/, '');
    const port = url.port ? `:${url.port}` : '';
    return `${host}${port}${path}${query}`;
}
