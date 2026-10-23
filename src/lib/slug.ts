// URL slug from a title: strips accents (so "Ọjà" becomes "oja"), keeps a-z and 0-9, max 80 chars.
export function slugify(title: string): string {
    const slug = title
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');
    return slug || 'post';
}
