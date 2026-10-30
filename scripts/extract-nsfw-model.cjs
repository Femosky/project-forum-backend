// One-time: writes NSFWJS's bundled MobileNetV2 model (MIT, github.com/infinitered/nsfwjs, trained by
// github.com/GantMan/nsfw_model) out as plain files the API loads from disk: models/nsfw-mobilenet-v2/model.json and
// its binary weights. Needs the package for this run only: npm install --no-save nsfwjs@4.4.0 @tensorflow/tfjs@4.22.0
// The package ships the weights as a base64 string inside JavaScript, and decoding that at
// startup costs about 300 MB of memory; raw files cost a fraction. To refresh the files:
//   node scripts/extract-nsfw-model.cjs
const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { MobileNetV2Model } = require('nsfwjs/models/mobilenet_v2');

(async () => {
    const out = path.join(__dirname, '..', 'models', 'nsfw-mobilenet-v2');
    mkdirSync(out, { recursive: true });
    const json = (await MobileNetV2Model.modelJson()).default;
    const weights = Buffer.from((await MobileNetV2Model.weightBundles[0]()).default, 'base64');
    writeFileSync(path.join(out, 'model.json'), JSON.stringify(json));
    writeFileSync(path.join(out, 'group1-shard1of1.bin'), weights);
    console.log(`Wrote ${out} (${(weights.length / 1048576).toFixed(1)} MB of weights)`);
})();
