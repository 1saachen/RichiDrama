const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');

test('explicit 4K sequence settings survive authenticated save, refresh and restart', async () => {
  const f = await modelCatalogFixture();
  try {
    const login = await f.request('POST', '/auth/login', { username: 'catalog-admin', password: 'fixture-password' });
    const first = await f.request('GET', '/omni-video-sequences/default', undefined, login.cookie);
    assert.equal(first.status, 200);
    const { id, shots } = first.body.data;
    const route = `/omni-video-sequences/${id}/shots/${shots[0].id}`;
    const input = { prompt: '保留真实的长镜头描述和 4K 输出。', settings: {
      model: 'doubao-seedance-2-5-260628', duration: 30, resolution: '4k', upscale_resolution: null,
    } };
    assert.equal((await f.request('PUT', route, input)).status, 401);
    const saved = await f.request('PUT', route, input, login.cookie);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.settings.resolution, '4k');
    await f.restart();
    const restored = await f.request('GET', `/omni-video-sequences/${id}`, undefined, login.cookie);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.shots[0].settings.resolution, '4k');
    assert.equal(restored.body.data.shots[0].settings.upscale_resolution, null);
    assert.equal(restored.body.data.shots[0].prompt, input.prompt);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 0);
  } finally { await f.close(); }
});
