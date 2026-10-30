import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { env } from '../config/env';

// Where uploaded images live. Production: Cloudflare R2 (S3-compatible, free egress), configured with the R2_*
// settings and served from R2_PUBLIC_URL (a public bucket URL or a custom domain). Without them (local dev, tests),
// files go to a folder on disk and the API serves them at /media/... so uploads work on 127.0.0.1 too.

export const LOCAL_MEDIA_DIR = path.resolve(env.MEDIA_DIR ?? path.join(__dirname, '../../uploads'));

const r2 =
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL
        ? {
              client: new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' }),
              endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`,
              publicUrl: env.R2_PUBLIC_URL.replace(/\/$/, ''),
          }
        : null;

export const storageDriver = () => (r2 ? 'r2' : 'local');

// The public base every stored file's URL starts with
export function mediaBase() {
    return r2 ? r2.publicUrl : `${env.API_URL}/media`;
}

export const isStoredMedia = (url: string) => url.startsWith(`${mediaBase()}/`);

// Stores a file under `key` (e.g. img/ad_logo/0193...-256.webp) and returns its public URL. Keys are never reused,
// so files are served with a year-long immutable cache.
export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    if (r2) {
        const response = await r2.client.fetch(`${r2.endpoint}/${key}`, {
            method: 'PUT',
            body: new Uint8Array(body),
            headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
        if (!response.ok) throw new Error(`R2 answered ${response.status} for ${key}`);
    } else {
        const file = path.join(LOCAL_MEDIA_DIR, key);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, body);
    }
    return `${mediaBase()}/${key}`;
}
