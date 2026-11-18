const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configuredModelLimits,
  modelLimits,
  validateResolution,
  validateAspectRatio,
} = require('../src/services/videoModelCapabilities');

const FAST_MODEL = 'doubao-seedance-2-0-fast-260128';
const MINI_MODEL = 'doubao-seedance-2-0-mini-260615';

test('only native regular Seedance 2.5 advertises the new 1080p and 4K tiers', () => {
  const native = { provider: 'volcengine' };
  const model = 'doubao-seedance-2-5-260628';
  assert.deepEqual(modelLimits({}, {}, model, native).resolutions, ['480p', '720p', '1080p', '4k']);
  assert.deepEqual(modelLimits({}, {}, model, { provider: 'richbest' }).resolutions, ['480p', '720p']);
  assert.deepEqual(modelLimits({}, {}, 'doubao-seedance-2-5-flash-261115', native).resolutions, ['480p', '720p']);
  assert.deepEqual(modelLimits({}, {}, MINI_MODEL, native).resolutions, ['480p', '720p']);
  assert.deepEqual(modelLimits({ video_model_limits: { [model]: { resolutions: ['720p'] } } }, {}, model, native).resolutions, ['720p']);
});

test('Seedance 2.5 Flash uses its own reference counts and cannot advertise unsupported output', () => {
  const { normalizeSupports } = require('../src/services/videoModelCapabilities');
  const { assetLimitsForCapability } = require('../src/services/omniVideoService');
  for (const model of ['doubao-seedance-2-5-flash-261115', 'doubao-seedance-2.5-flash']) {
    const limits = modelLimits({ video_model_limits: { [model]: {
      resolutions: ['480p', '720p', '1080p', '4k'], image_reference: { max: 30 }, video_reference: { max: 10 }, audio_reference: { max: 10 }, total_reference: { max: 50 },
    } } }, {}, model);
    assert.deepEqual(limits.resolutions, ['480p', '720p']);
    assert.equal(limits.duration.max, 30);
    assert.deepEqual(assetLimitsForCapability({ model, limits }), { total: 20, image: 10, video: 5, audio: 5 });
    assert.deepEqual(assetLimitsForCapability({ model }), { total: 20, image: 10, video: 5, audio: 5 });
    assert.equal(normalizeSupports({ provider: 'volcengine' }, {}, model).image_reference.max, 10);
    assert.throws(() => validateResolution({ model, limits }, '1080p'), /不支持 1080p/);
  }
  assert.equal(modelLimits({}, {}, 'doubao-seedance-2-5-260628').image_reference.max, 30);
  assert.equal(modelLimits({}, {}, 'dreamina-seedance-2.5').duration.max, 15, 'Existing alias behavior is outside this change');
});

test('Seedance 2.0 Fast native and relay model IDs reject 1080p source output', () => {
  for (const model of [FAST_MODEL, 'doubao-seedance-2.0-fast', 'dreamina-seedance-2.0-fast']) {
    const limits = modelLimits({}, {}, model);
    assert.deepEqual(limits.resolutions, ['480p', '720p']);
    assert.equal(validateResolution({ model, limits }, '720p'), '720p');
    assert.throws(() => validateResolution({ model, limits }, '1080p'), /不支持 1080p 原片/);
  }
});

test('Volcengine capabilities reject project-only aspect ratios', () => {
  const model = MINI_MODEL;
  const limits = modelLimits({}, {}, model, { api_protocol: 'volcengine_omni' });
  assert.deepEqual(limits.aspect_ratios, ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']);
  assert.equal(validateAspectRatio({ model, limits }, '9:16'), '9:16');
  assert.throws(() => validateAspectRatio({ model, limits }, '2:3'), /不支持 2:3 画幅/);
});

test('Seedance 2.0 Mini aliases limit source output to 480p and 720p', () => {
  for (const model of [MINI_MODEL, 'doubao-seedance-2.0-mini', 'doubao-seedance-2-0-mini']) {
    const limits = modelLimits({}, {}, model);
    assert.deepEqual(limits.resolutions, ['480p', '720p']);
    assert.equal(validateResolution({ model, limits }, '480p'), '480p');
    assert.equal(validateResolution({ model, limits }, '720p'), '720p');
    assert.throws(() => validateResolution({ model, limits }, '1080p'), /不支持 1080p 原片/);
  }
  const configured = { video_model_limits: { [MINI_MODEL]: { resolutions: ['720P', '1080p'] } } };
  assert.deepEqual(modelLimits(configured, {}, MINI_MODEL).resolutions, ['720p']);
  assert.deepEqual(modelLimits({}, {}, 'doubao-seedance-2-0-260128').resolutions, ['480p', '720p', '1080p']);
});

test('an exact model entry can narrow Fast source resolutions without expanding them', () => {
  const settings = { video_capabilities: { models: { [FAST_MODEL]: { limits: { resolutions: ['720p', '1080p'] } } } } };
  assert.deepEqual(configuredModelLimits(settings, FAST_MODEL.toUpperCase()), { resolutions: ['720p', '1080p'] });
  assert.deepEqual(modelLimits(settings, {}, FAST_MODEL).resolutions, ['720p']);
});
