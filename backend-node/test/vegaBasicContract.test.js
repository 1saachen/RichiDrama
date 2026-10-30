const test = require('node:test');
const assert = require('node:assert/strict');
const relay = require('../src/services/richbestProvider');
const caps = require('../src/services/videoModelCapabilities');

for (const model of ['vega-1.0-lite', 'vega-1.0-pro', 'vega-1.0-pro-fast', 'vega-1.0-pro-mini', 'vega-1.5-pro']) {
  test(`${model} basic request and advertised capabilities follow the relay contract`, () => {
    const lite = model.endsWith('lite');
    const built = relay.buildVideoBody({ model, prompt: 'sea', params: { duration: 4, watermark: false, camera_fixed: false } });
    assert.deepEqual(built.body, { model, content: [{ type: 'text', text: 'sea' }], resolution: lite ? '480p' : '720p', ratio: '16:9', duration: 4 });
    assert.equal(built.profile.supportsCancel, false);
    const config = { provider: 'richbest' };
    assert.equal(caps.normalizeSupports(config, {}, model).image_reference.max, 0);
    const limits = caps.modelLimits({}, {}, model, config);
    assert.equal(limits.duration.max, model === 'vega-1.5-pro' ? 30 : 15);
    assert.deepEqual(limits.resolutions, lite ? ['480p', '1080p'] : ['720p', '1080p']);
    for (const params of [{ duration: -1 }, { duration: 3 }, { duration: 4.5 }, { ratio: 'adaptive' }, { resolution: lite ? '720p' : '480p' }, { vega: { task_type: 'extend' } }]) {
      assert.throws(() => relay.assertVideoRequestShape({ model, params }), /Vega/);
    }
    assert.throws(() => relay.assertVideoRequestShape({ model, references: [{ kind: 'image', role: 'first_frame' }] }), /Vega/);
    assert.throws(() => relay.buildVideoBody({ model, params: { seed: lite ? 1 : 2147483648 } }), /seed/);
    if (!lite) assert.equal(relay.buildVideoBody({ model, params: { seed: -1 } }).body.seed, -1);
  });
}

test('existing Seedance request behavior remains unchanged', () => {
  const body = relay.buildVideoBody({ model: 'doubao-seedance-2.0', prompt: 'sea', params: { watermark: false, camera_fixed: false, duration: 4 } }).body;
  assert.equal(body.task_type, 't2v');
  assert.equal(body.watermark, false);
  assert.equal(body.camera_fixed, false);
});
