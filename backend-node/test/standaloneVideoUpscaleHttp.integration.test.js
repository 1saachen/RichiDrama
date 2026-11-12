const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createRecoveryFixture } = require('./helpers/recoveryFixture');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const configs = require('../src/services/aiConfigService');
const billing = require('../src/services/billingService');
const jobs = require('../src/services/standaloneVideoUpscaleService');

const MODEL = 'volcengine-video-generative-enhancement';
const log = { warn() {}, error() {}, info() {} };

function makeVideo(directory, size) {
  const file = path.join(directory, `fixture-${size}.mp4`);
  const result = spawnSync(getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', `color=blue:s=${size}:r=24:d=1`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', file], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return fs.readFileSync(file);
}

test('standalone upload, private preview, guarded billing, and restart-safe upscale use project HTTP routes', async (t) => {
  const fixture = await createRecoveryFixture();
  const cfg = { storage: { local_path: fixture.directory } };
  let stopWorker;
  let provider;
  t.after(async () => {
    await stopWorker?.();
    if (provider) await new Promise((resolve) => provider.close(resolve));
    await fixture.close();
  });
  const input = makeVideo(fixture.directory, '360x640');
  const output = makeVideo(fixture.directory, '720x1280');
  const seen = [];
  let ready = false;
  let submissions = 0;
  let base;
  provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(req.url);
    const send = (data) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(data));
    if (req.url.endsWith('request-media-upload-url')) {
      return send({ result: { upload_url: base + '/upload', file_id: 'mediakit://fixture' } });
    }
    if (req.url === '/upload') {
      assert.deepEqual(Buffer.concat(chunks), input);
      return res.end();
    }
    if (req.url.endsWith('enhance-video-generative')) {
      submissions++;
      const payload = JSON.parse(Buffer.concat(chunks));
      assert.equal(payload.resolution, '720p');
      assert.equal(payload.fps, undefined);
      assert.match(payload.client_token, /^standalone-up-/);
      assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE reference_type='standalone_video_upscale' AND type='authorization'").get().n, 1);
      return send({ task_id: 'upscale-task', request_id: 'upscale-submit' });
    }
    if (req.url.endsWith('/tasks/upscale-task')) {
      return send(ready ? { status: 'completed', request_id: 'upscale-result', result: { video_url: base + '/result.mp4' } } : { status: 'processing' });
    }
    if (req.url === '/result.mp4') return res.setHeader('Content-Type', 'video/mp4').end(output);
    res.writeHead(404).end();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  base = `http://127.0.0.1:${provider.address().port}`;

  const actorId = fixture.user.id;
  const config = configs.createConfig(fixture.db, log, {
    name: 'isolated upscale', service_type: 'video_postprocess', provider: 'volcengine_mediakit',
    base_url: base, api_key: 'fake-only', model: [MODEL], default_model: MODEL, is_default: true,
  });
  fixture.db.prepare("UPDATE ai_model_catalog SET status='active' WHERE service_type='video_postprocess' AND model=?").run(MODEL);
  const account = fixture.db.prepare('INSERT INTO cost_accounts(name,provider,created_at,created_by) VALUES(?,?,?,?)')
    .run('fake MediaKit account', 'volcengine_mediakit', new Date().toISOString(), fixture.admin.id).lastInsertRowid;
  fixture.db.prepare('INSERT INTO cost_account_bindings VALUES(?,?,?)').run(config.id, account, new Date().toISOString());
  billing.adjustBalance(fixture.db, fixture.admin.id, actorId, 100, 'isolated upscale test');
  const at = new Date().toISOString();
  const historical = fixture.db.prepare(`INSERT INTO video_generations(owner_user_id,provider,model,status,local_path,created_at,updated_at)
    VALUES (?,'volcengine','old-model','completed','videos/historical.mp4',?,?)`).run(actorId, at, at).lastInsertRowid;
  const historicalBefore = fixture.db.prepare('SELECT * FROM video_generations WHERE id=?').get(historical);

  const request = (method, route, cookie, body, headers = {}) => fetch(`${fixture.url}/api/v1${route}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...headers }, body,
  });
  async function login(username) {
    const response = await request('POST', '/auth/login', null, JSON.stringify({ username, password: 'Creator123' }), { 'content-type': 'application/json' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function json(method, route, cookie, body) {
    const response = await request(method, route, cookie, body && JSON.stringify(body), { 'content-type': 'application/json' });
    const payload = await response.json();
    return { status: response.status, job: payload.data, payload };
  }
  async function until(route, status) {
    for (let n = 0; n < 160; n++) {
      const item = await json('GET', route, cookie);
      if (item.job?.status === status) return item.job;
      assert.ok(!['failed', 'reconciliation'].includes(item.job?.status), JSON.stringify(item));
      await delay(50);
    }
    assert.fail(`Job did not become ${status}`);
  }

  const cookie = await login(fixture.user.username);
  const other = await login(fixture.other.username);
  const endpoint = '/video-upscales';
  assert.equal((await request('GET', endpoint)).status, 401);
  const fake = new FormData();
  fake.append('file', new Blob(['not media']), 'fake.mp4');
  assert.equal((await request('POST', endpoint, cookie, fake)).status, 400);
  const form = new FormData();
  form.append('file', new Blob([input], { type: 'video/mp4' }), 'source.mp4');
  form.append('name', '竖屏原片.mp4');
  const imported = await request('POST', endpoint, cookie, form);
  assert.equal(imported.status, 201);
  const { data: draft } = await imported.json();
  const route = `${endpoint}/${draft.id}`;
  assert.equal(draft.status, 'ready');
  assert.equal(draft.name, '竖屏原片.mp4');
  assert.deepEqual([draft.source.width, draft.source.height, draft.source.fps], [360, 640, 24]);
  assert.deepEqual(draft.targets, ['720p', '1080p']);
  assert.equal((await json('GET', endpoint, other)).job.items.length, 0);
  for (const suffix of ['', '/media/source', '/media/result', '/quote', '/submit']) {
    assert.equal((await request(suffix === '/quote' || suffix === '/submit' ? 'POST' : 'GET', route + suffix, other)).status, 404);
  }
  const range = await request('GET', route + '/media/source', cookie, undefined, { range: 'bytes=0-31' });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), input.subarray(0, 32));
  const body = { target_resolution: '720p' };
  const quote = await json('POST', route + '/quote', cookie, body);
  assert.equal(quote.status, 200, JSON.stringify(quote.payload));
  assert.ok(quote.job.amount_micro > 0);
  assert.equal((await json('POST', route + '/submit', cookie, { ...body, amount_micro: -1 })).status, 400);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE reference_type='standalone_video_upscale'").get().n, 0);
  assert.deepEqual(seen, [], 'import, preview and quote never contact MediaKit');

  const submit = () => json('POST', route + '/submit', cookie, { ...body, amount_micro: quote.job.amount_micro });
  const [first, duplicate] = await Promise.all([submit(), submit()]);
  assert.equal(first.job.status, 'queued', JSON.stringify(first.payload));
  assert.equal(duplicate.job.id, first.job.id);
  stopWorker = jobs.resume(fixture.db, log, cfg);
  await until(route, 'processing');
  await stopWorker();
  stopWorker = null;
  await fixture.restart();
  assert.equal((await json('GET', route, cookie)).job.status, 'processing');
  assert.deepEqual(fixture.db.prepare('SELECT * FROM video_generations WHERE id=?').get(historical), historicalBefore);
  ready = true;
  stopWorker = jobs.resume(fixture.db, log, cfg);
  const completed = await until(route, 'completed');
  assert.deepEqual([completed.output.width, completed.output.height, completed.output.fps, completed.output.audio], [720, 1280, 24, true]);
  assert.equal(submissions, 1, 'restart queries the original task');
  const download = await request('GET', route + '/media/result?download=1', cookie);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), output);
  const usage = fixture.db.prepare("SELECT * FROM billing_usage_logs WHERE reference_type='standalone_video_upscale'").all();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider_request_id, 'upscale-result');
  assert.equal(JSON.parse(usage[0].usage_json).millisecond, completed.output.duration_ms);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM cost_calls WHERE model=?").get(MODEL).n, 1);
  const providerRequests = seen.length;
  await stopWorker();
  stopWorker = null;
  await fixture.restart();
  assert.equal((await json('GET', route, cookie)).job.status, 'completed');
  assert.equal((await request('GET', route + '/media/result', cookie)).status, 200);
  assert.equal(seen.length, providerRequests, 'completed result reads are local');
});
