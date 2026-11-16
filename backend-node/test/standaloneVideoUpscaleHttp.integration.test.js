const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p',
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
  // A valid MP4 with a padding box crosses the old 30 MB limit without
  // needing a long, expensive-to-encode fixture.
  const padding = Buffer.alloc(32 * 1024 ** 2);
  padding.writeUInt32BE(padding.length);
  padding.write('free', 4, 'ascii');
  const inputBytes = input.length + padding.length;
  const inputHash = createHash('sha256').update(input).update(padding).digest('hex');
  const output = makeVideo(fixture.directory, '720x1280');
  const highInput = makeVideo(fixture.directory, '1920x1080');
  const results = {
    'upscale-task': output,
    '2k-2': makeVideo(fixture.directory, '2560x1440'),
    '4k-3': makeVideo(fixture.directory, '3840x2160'),
    '4k-4': highInput,
  };
  const seen = [];
  const resolutions = [];
  let ready = false;
  let submissions = 0;
  let base;
  provider = http.createServer(async (req, res) => {
    seen.push(req.url);
    if (req.url === '/upload') {
      const digest = createHash('sha256');
      let length = 0;
      for await (const chunk of req) {
        digest.update(chunk);
        length += chunk.length;
      }
      const legacy = !submissions;
      assert.equal(length, legacy ? inputBytes : highInput.length);
      assert.equal(digest.digest('hex'), legacy ? inputHash : createHash('sha256').update(highInput).digest('hex'));
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = (data) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(data));
    if (req.url.endsWith('request-media-upload-url')) {
      return send({ result: { upload_url: base + '/upload', file_id: 'mediakit://fixture' } });
    }
    if (req.url.endsWith('enhance-video-generative')) {
      submissions++;
      const payload = JSON.parse(Buffer.concat(chunks));
      resolutions.push(payload.resolution);
      assert.equal(payload.fps, undefined);
      assert.match(payload.client_token, /^standalone-up-/);
      const authorization = fixture.db.prepare('SELECT authorization_id FROM standalone_video_upscale_jobs WHERE id=?')
        .get(payload.client_token.slice('standalone-up-'.length)).authorization_id;
      assert.equal(billing.getAuthorization(fixture.db, authorization).snapshot.pricing_context.resolution_tier, payload.resolution);
      return send({ task_id: submissions === 1 ? 'upscale-task' : `${payload.resolution}-${submissions}`, request_id: `upscale-submit-${submissions}` });
    }
    const task = req.url.match(/\/tasks\/([^/]+)$/)?.[1];
    if (task && Object.hasOwn(results, task)) {
      return send(ready ? { status: 'completed', request_id: task === 'upscale-task' ? 'upscale-result' : `result-${task}`, result: { video_url: base + `/result/${task}.mp4` } } : { status: 'processing' });
    }
    const result = req.url.match(/^\/result\/([^/]+)\.mp4$/)?.[1];
    if (result && Object.hasOwn(results, result)) {
      return res.setHeader('Content-Type', 'video/mp4').end(results[result]);
    }
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
    let item;
    for (let n = 0; n < 230; n++) {
      item = await json('GET', route, cookie);
      if (item.job?.status === status) return item.job;
      assert.ok(!['failed', 'reconciliation'].includes(item.job?.status), JSON.stringify(item));
      await delay(50);
    }
    assert.fail(`Job did not become ${status}: ${JSON.stringify(item?.job)}; requests: ${seen.slice(-12).join(', ')}`);
  }

  const cookie = await login(fixture.user.username);
  const other = await login(fixture.other.username);
  const endpoint = '/video-upscales';
  assert.equal((await request('GET', endpoint)).status, 401);
  const fake = new FormData();
  fake.append('file', new Blob(['not media']), 'fake.mp4');
  assert.equal((await request('POST', endpoint, cookie, fake)).status, 400);
  const form = new FormData();
  form.append('file', new Blob([input, padding], { type: 'video/mp4' }), 'source.mp4');
  form.append('name', '竖屏原片.mp4');
  const imported = await request('POST', endpoint, cookie, form);
  assert.equal(imported.status, 201);
  const { data: draft } = await imported.json();
  const route = `${endpoint}/${draft.id}`;
  assert.equal(draft.status, 'ready');
  assert.equal(draft.name, '竖屏原片.mp4');
  assert.equal(draft.source.size_bytes, inputBytes);
  assert.deepEqual([draft.source.width, draft.source.height, draft.source.fps], [360, 640, 24]);
  assert.deepEqual(draft.targets, ['720p', '1080p', '2k', '4k']);
  // Simulate an upload record created before the new resolution options.
  fixture.db.prepare("UPDATE standalone_video_upscale_jobs SET source_media_json=json_remove(source_media_json,'$.upscale_targets_version') WHERE id=?").run(draft.id);
  assert.deepEqual((await json('GET', route, cookie)).job.targets, ['720p', '1080p']);
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

  const item = fixture.db.prepare('SELECT id,conditions_json FROM billing_price_book_items WHERE service_type=? AND model=? AND meter=?')
    .get('video_postprocess', MODEL, 'millisecond');
  const prices = JSON.parse(item.conditions_json);
  assert.deepEqual(prices.rates.filter((rate) => rate.when.resolution_tier === '4k').map((rate) =>
    [rate.when.fps_tier, rate.unit_price_points, rate.unit_size]), [['lte30', 2000, 60000], ['lte60', 4000, 60000], ['lte120', 8000, 60000]]);
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/93_standalone_upscale_4k_price.sql'), 'utf8');
  fixture.db.exec(migration);
  assert.equal(fixture.db.prepare('SELECT conditions_json FROM billing_price_book_items WHERE id=?').get(item.id).conditions_json, item.conditions_json);

  async function importHigh() {
    const data = new FormData();
    data.append('file', new Blob([highInput], { type: 'video/mp4' }), '1080p.mp4');
    const response = await request('POST', endpoint, cookie, data);
    assert.equal(response.status, 201);
    const { data: job } = await response.json();
    assert.deepEqual(job.targets, ['2k', '4k']);
    return { highRoute: `${endpoint}/${job.id}`, job };
  }
  const two = await importHigh();
  const four = await importHigh();
  const mismatch = await importHigh();
  const rateUpdate = fixture.db.prepare('UPDATE billing_price_book_items SET conditions_json=? WHERE id=?');
  const fourBody = { target_resolution: '4k' };
  rateUpdate.run(JSON.stringify({ ...prices, rates: prices.rates.filter((rate) => rate.id !== '4k_30') }), item.id);
  const noRate = await json('POST', four.highRoute + '/quote', cookie, fourBody);
  assert.equal(noRate.status, 400);
  assert.match(JSON.stringify(noRate.payload), /未配置 4K/);
  assert.equal((await json('POST', four.highRoute + '/submit', cookie, { ...fourBody, amount_micro: 0 })).status, 400);
  assert.equal(fixture.db.prepare('SELECT authorization_id FROM standalone_video_upscale_jobs WHERE id=?').get(four.job.id).authorization_id, null);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE reference_type='standalone_video_upscale' AND type='authorization'").get().n, 1);
  assert.equal(seen.length, providerRequests, 'price fallback never contacts MediaKit');
  rateUpdate.run(item.conditions_json, item.id);

  const queue = async ({ highRoute, job }, targetResolution, unitPoints) => {
    const body = { target_resolution: targetResolution };
    const price = await json('POST', highRoute + '/quote', cookie, body);
    assert.equal(price.status, 200, JSON.stringify(price.payload));
    const expected = Math.round(job.source.duration_ms * unitPoints * 10000 / 60000);
    assert.equal(price.job.amount_micro, expected);
    const reply = await json('POST', highRoute + '/submit', cookie, { ...body, amount_micro: expected });
    assert.equal(reply.job?.status, 'queued', JSON.stringify(reply.payload));
  };
  ready = false;
  await queue(two, '2k', 1000);
  stopWorker = jobs.resume(fixture.db, log, cfg);
  await until(two.highRoute, 'processing');
  await stopWorker();
  stopWorker = null;
  await fixture.restart();
  assert.equal((await json('GET', two.highRoute, cookie)).job.status, 'processing');
  ready = true;
  stopWorker = jobs.resume(fixture.db, log, cfg);
  for (const [record, target, unitPoints, width, height, taskId] of [
    [two, '2k', 1000, 2560, 1440, '2k-2'],
    [four, '4k', 2000, 3840, 2160, '4k-3'],
  ]) {
    if (record !== two) await queue(record, target, unitPoints);
    const done = await until(record.highRoute, 'completed');
    assert.deepEqual([done.target_resolution, done.output.width, done.output.height, done.output.fps, done.output.audio],
      [target, width, height, 24, true]);
    const download = await request('GET', record.highRoute + '/media/result?download=1', cookie);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), results[taskId]);
    const logs = fixture.db.prepare("SELECT charged_micro,snapshot_json FROM billing_usage_logs WHERE reference_type='standalone_video_upscale' AND reference_id=?").all(record.job.id);
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0].snapshot_json).pricing_context.resolution_tier, target);
    assert.equal(logs[0].charged_micro, Math.round(done.output.duration_ms * unitPoints * 10000 / 60000));
  }
  await queue(mismatch, '4k', 2000);
  await until(mismatch.highRoute, 'reconciliation');
  assert.equal((await request('GET', mismatch.highRoute + '/media/result', cookie)).status, 404);
  assert.equal(fixture.db.prepare("SELECT count(*) AS n FROM billing_usage_logs WHERE reference_type='standalone_video_upscale' AND reference_id=?").get(mismatch.job.id).n, 0);
  assert.deepEqual(resolutions, ['720p', '2k', '4k', '4k']);
});
