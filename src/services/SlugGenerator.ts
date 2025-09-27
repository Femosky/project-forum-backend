export class SlugGenerator {
    public static async generateSlug(title: string): Promise<string> {
        return title
            .toLowerCase()
            .replace(/ /g, '-')
            .replace(/[^a-z0-9-]/g, '');
    }
}
