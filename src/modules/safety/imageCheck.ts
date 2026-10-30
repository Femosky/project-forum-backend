import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import logger from '../../lib/logger';
import type { Verdict } from './moderation';

// The site's own picture check, run inside the API with no outside service: NSFWJS's MobileNetV2 model (MIT,
// github.com/infinitered/nsfwjs, trained by github.com/GantMan/nsfw_model), stored in models/nsfw-mobilenet-v2 (see
// scripts/extract-nsfw-model.cjs) and run with TensorFlow.js on the CPU. It scores a picture as Drawing, Hentai,
// Neutral, Porn or Sexy.
//
// It loads on the first picture, not at startup: about 0.1 s and 50 MB, with another 50 to 70 MB while a picture is
// checked, which takes about a second. Accuracy is roughly nine in ten on the model's own tests: it can miss things
// and it can flag swimwear, skin-coloured scenes or drawings by mistake. So clear cases are decided automatically and
// borderline ones go to a person; Cloudflare's CSAM Scanning Tool (hash matching on the image domain) is still
// required before picture posts are public, and nothing here replaces it.

const CLASSES = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'] as const;
export type ImageScores = Record<(typeof CLASSES)[number], number>;
export type ImagePurposeForCheck = 'post_image' | 'ad_image' | 'ad_logo' | 'community_icon' | 'community_banner' | 'link_preview';

type Model = { predict: (input: unknown) => unknown };
type Tf = typeof import('@tensorflow/tfjs-core');
let loading: Promise<{ tf: Tf; model: Model }> | null = null;

function modelDir() {
    const candidates = [path.resolve(process.cwd(), 'models/nsfw-mobilenet-v2'), path.resolve(__dirname, '../../../models/nsfw-mobilenet-v2'), path.resolve(__dirname, '../../../../models/nsfw-mobilenet-v2')];
    const found = candidates.find((dir) => existsSync(path.join(dir, 'model.json')));
    if (!found) throw new Error('The picture-check model files are missing (models/nsfw-mobilenet-v2)');
    return found;
}

async function loadModel() {
    const started = Date.now();
    const tf = await import('@tensorflow/tfjs-core');
    await import('@tensorflow/tfjs-backend-cpu');
    const layers = await import('@tensorflow/tfjs-layers');
    await tf.setBackend('cpu');
    const dir = modelDir();
    const json = JSON.parse(readFileSync(path.join(dir, 'model.json'), 'utf8'));
    const weights = readFileSync(path.join(dir, 'group1-shard1of1.bin'));
    const model = await layers.loadLayersModel(
        tf.io.fromMemory({
            modelTopology: json.modelTopology,
            weightSpecs: json.weightsManifest[0].weights,
            weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.length),
        })
    );
    logger.info({ ms: Date.now() - started }, 'Picture check model loaded');
    return { tf, model: model as unknown as Model };
}

// Scores for a picture (any format sharp reads), or null when the check couldn't run
export async function scoreImage(image: Buffer): Promise<ImageScores | null> {
    try {
        loading ??= loadModel();
        const { tf, model } = await loading;
        // The model's input: 224x224 RGB, values 0 to 1 (as NSFWJS prepares it)
        const { data } = await sharp(image, { animated: false }).rotate().resize(224, 224, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixels = new Float32Array(data.length);
        for (let index = 0; index < data.length; index++) pixels[index] = data[index] / 255;
        const output = tf.tidy(() => model.predict(tf.tensor4d(pixels, [1, 224, 224, 3])) as ReturnType<Tf['tensor']>);
        const values = await output.data();
        output.dispose();
        return Object.fromEntries(CLASSES.map((name, index) => [name, values[index]])) as ImageScores;
    } catch (error) {
        loading = null;
        logger.error({ err: error }, 'Picture check failed; letting the picture through');
        return null;
    }
}

export type ImageVerdict = Verdict | { action: 'refuse'; reason: string };

// What to do with a picture, from its scores. "Explicit" is porn and hentai together.
//   - posts: clearly explicit (0.85 or more) is refused at upload; borderline (0.5 or more) holds the post for the
//     admins; "sexy" (0.6 or more) adds the mature label;
//   - icons, banners and ad pictures have no review step, so anything borderline is refused, and ads refuse "sexy" too;
//   - link-preview pictures: dropped, and the post held for the admins when explicit, or labelled mature when "sexy".
export function judgeImage(scores: ImageScores | null, purpose: ImagePurposeForCheck): ImageVerdict {
    if (!scores) return { action: 'publish' };
    const explicit = scores.porn + scores.hentai;
    if (purpose === 'post_image' || purpose === 'link_preview') {
        if (explicit >= 0.85 && purpose === 'post_image') return { action: 'refuse', reason: "This picture can't be posted. Sexual content isn't allowed on the site." };
        if (explicit >= 0.5) return { action: 'hold_for_admins', reason: 'Picture may be sexual (automatic check)' };
        if (scores.sexy >= 0.6) return { action: 'label_mature', reason: 'Revealing picture' };
        return { action: 'publish' };
    }
    const isAd = purpose === 'ad_image' || purpose === 'ad_logo';
    if (explicit >= 0.5 || scores.sexy >= (isAd ? 0.6 : 0.8)) return { action: 'refuse', reason: "This picture can't be used here." };
    return { action: 'publish' };
}

export async function checkImage(image: Buffer, purpose: ImagePurposeForCheck): Promise<ImageVerdict> {
    return judgeImage(await scoreImage(image), purpose);
}
