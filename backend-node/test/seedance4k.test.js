const test = require('node:test');
const assert = require('node:assert/strict');

test('4K reserves from the documented canvas instead of the legacy unknown-resolution fallback', () => {
  const estimate = require('../src/services/videoTokenEstimate');
  const result = estimate.describeReserve({ duration: 5, resolution: '4k', aspectRatio: '16:9' });
  assert.deepEqual(result.canvas, { width: 3840, height: 2160 });
  assert.equal(result.output_tokens, 1117800);
  assert.ok(result.output_tokens > 3.99 * estimate.estimateOutputTokens({ duration: 5, resolution: '1080p', aspectRatio: '16:9' }));
  for (const [aspectRatio, width, height] of [['4:3',3326,2494],['1:1',2880,2880],['3:4',2494,3326],['21:9',4398,1886]]) {
    const variant = estimate.describeReserve({ duration: 5, resolution: '4k', aspectRatio });
    assert.deepEqual(variant.canvas, { width, height });
    assert.ok(variant.output_tokens >= 1117800 && variant.output_tokens <= 1118000);
  }
  const video = require('../src/services/videoService');
  assert.deepEqual(video.targetVideoPixelsForAspect('adaptive','4k',{width:2880,height:2880}), {w:2880,h:2880,aspect_ratio:'adaptive',short_edge:2880});
  assert.throws(()=>video.targetVideoPixelsForAspect('adaptive','4k',{width:1280,height:720}), /原生 4K/);
});
