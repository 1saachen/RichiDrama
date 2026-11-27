const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { loadConfig } = require('../src/config');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const auth = require('../src/services/authService');
const billing = require('../src/services/billingService');
const client = require('../src/services/seedAudioClient');

const log = { debug() {}, info() {}, warn() {}, error() {} };

function toneFixture() {
  const result = spawnSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1',
    '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1',
  ]);
  assert.equal(result.status, 0, result.error?.message || result.stderr?.toString());
  return result.stdout;
}

async function startRouter(cfg, db) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(cfg, db, log));
  app.use((_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/api/v1',
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function seedPriorConfiguration(db, admin, apiKey) {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare('INSERT INTO seed_audio_local_config(id,api_key,updated_at) VALUES(1,?,?)').run(apiKey, at);
    db.prepare(`INSERT INTO ai_model_catalog(service_type,model,display_name,status,created_at,updated_at)
      VALUES('audio_generation','seed-audio-1.0','豆包音频生成模型 1.0','active',?,?)`).run(at, at);
    billing.savePriceBook(db, admin.id, {
      name: 'Seed Audio fixture price', provider: 'volcengine_voice', status: 'published',
      items: [{ service_type: 'audio_generation', model: 'seed-audio-1.0', meter: 'millisecond', unit_price: 100, conditions_json: { unit_size: 60000 } }],
    });
  })();
  return at;
}

test('local Seed Audio retains prior configuration and authenticates, reserves, archives, and settles after database reopen', async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'richidrama-seed-audio-'));
  const filename = path.join(temp, 'test.db');
  const storage = path.join(temp, 'storage');
  const apiKey = 'synthetic-seed-audio-key-for-test';
  const originalSend = client.send;
  const audio = toneFixture();
  const originalProfile = process.env.MINIDRAMA_PROFILE;
  process.env.MINIDRAMA_PROFILE = 'dev';
  loadConfig();
  let db = new Database(filename);
  let router;
  t.after(async () => {
    if (router) await router.close();
    if (db.open) db.close();
    if (originalProfile === undefined) delete process.env.MINIDRAMA_PROFILE;
    else process.env.MINIDRAMA_PROFILE = originalProfile;
    client.send = originalSend;
    rmSync(temp, { recursive: true, force: true });
  });

  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    runMigrationsAndEnsure(db);
    runMigrationsAndEnsure(db);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  const admin = auth.ensureBootstrapAdmin(db, log);
  const user = auth.createUser(db, { username: 'audio-user', password: 'isolated-fixture-pass' }, admin.id);
  const adminHeaders = { 'x-lmd-session': auth.issueSession(db, admin).token };
  const userHeaders = { 'x-lmd-session': auth.issueSession(db, user).token };
  billing.adjustBalance(db, admin.id, admin.id, 500, 'isolated fixture balance');
  const egressProxy = 'http://127.0.0.1:9';
  const cfg = { storage: { type: 'local', local_path: storage }, server: { egress_proxy: egressProxy }, payments: { enabled: false } };
  router = await startRouter(cfg, db);
  const base = '/tools/audio-generation';
  async function call(method, resource, body, headers = adminHeaders) {
    const response = await fetch(router.url + base + resource, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...await response.json() };
  }
  async function findJob(id, desired) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await call('GET', '/jobs');
      const job = listed.data.items.find(item => item.id === id);
      if (job?.status === desired) return job;
      if (job && ['completed', 'failed', 'pending_reconciliation'].includes(job.status)) {
        assert.equal(job.status, desired, JSON.stringify(job));
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('job did not reach ' + desired);
  }

  let submits = 0;
  let received;
  let vendorMode = 'ok';
  client.send = async ({ apiKey, requestId, prompt, timeoutMs, proxyUrl }) => {
    submits += 1;
    received = { key: apiKey, requestId, prompt, timeoutMs, proxyUrl };
    assert.equal(billing.publicAccount(billing.payerAccount(db, admin.id)).frozen, 200);
    if (vendorMode === 'rejected') return new Response('{}', { status: 401 });
    if (vendorMode === 'unsubmitted') throw Object.assign(new Error('simulated TLS failure'), {
      code: 'SEED_AUDIO_UNSUBMITTED', phase: 'destination_tls', diagnosticCode: 'ECONNRESET',
    });
    if (vendorMode === 'lost') throw new Error('simulated connection loss');
    return Response.json({ code: 0, audio: audio.toString('base64'), duration: 1, original_duration: 1.2 }, {
      headers: { 'X-Tt-Logid': 'synthetic-provider-logid' },
    });
  };

  assert.equal((await call('POST', '/jobs', { prompt: 'music', request_id: randomUUID() }, {})).status, 401);
  assert.equal((await call('GET', '/config', null, userHeaders)).data.available, false);
  assert.equal((await call('POST', '/jobs', { prompt: 'music', request_id: randomUUID() }, userHeaders)).status, 403);
  for (const extra of [{ origin: 'https://example.invalid' }, { 'x-forwarded-for': '192.0.2.20' }]) {
    const result = await call('POST', '/jobs', { prompt: 'music', request_id: randomUUID() }, { ...adminHeaders, ...extra });
    assert.equal(result.status, 403);
  }
  assert.equal((await call('GET', '/config')).data.configured, false);
  assert.equal((await call('POST', '/jobs', { prompt: 'music', request_id: randomUUID() })).status, 409);
  assert.equal((await call('PUT', '/config', { api_key: apiKey })).status, 404);
  assert.equal((await call('GET', '/config')).data.configured, false);

  const keyUpdatedAt = seedPriorConfiguration(db, admin, apiKey);
  const configuration = await call('GET', '/config');
  assert.equal(configuration.status, 200);
  assert.equal(configuration.data.configured, true);
  assert.equal(configuration.data.rate_credits_per_minute, 100);
  assert.ok(!JSON.stringify(configuration).includes(apiKey));
  assert.equal((await call('PUT', '/config', { api_key: 'synthetic-replacement-key' })).status, 404);
  assert.deepEqual(db.prepare('SELECT api_key,updated_at FROM seed_audio_local_config WHERE id=1').get(),
    { api_key: apiKey, updated_at: keyUpdatedAt });
  assert.equal(submits, 0);

  const request = { prompt: '一小段悬疑感的钢琴配乐', request_id: randomUUID() };
  const first = await call('POST', '/jobs', request);
  assert.equal(first.status, 201, JSON.stringify(first));
  const replay = await call('POST', '/jobs', request);
  assert.equal(replay.data.id, first.data.id);
  const conflict = await call('POST', '/jobs', { ...request, prompt: 'another prompt' });
  assert.equal(conflict.status, 409);
  const completed = await findJob(first.data.id, 'completed');
  assert.equal(submits, 1);
  assert.equal(received.key, apiKey);
  assert.match(received.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(received.prompt, request.prompt);
  assert.equal(received.timeoutMs, 300000);
  assert.equal(received.proxyUrl, egressProxy);
  assert.ok(completed.audio_url.startsWith('/static/'));
  assert.deepEqual(readFileSync(path.resolve(storage, completed.local_path)), audio);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets WHERE local_path=? AND owner_user_id=?').get(completed.local_path, admin.id).n, 1);
  const usage = db.prepare("SELECT usage_json,charged_micro,provider_request_id FROM billing_usage_logs WHERE service_type='audio_generation'").all();
  assert.equal(usage.length, 1);
  assert.equal(JSON.parse(usage[0].usage_json).millisecond, 1200);
  assert.equal(usage[0].charged_micro, 20000);
  assert.equal(usage[0].provider_request_id, 'synthetic-provider-logid');
  assert.equal(billing.publicAccount(billing.payerAccount(db, admin.id)).frozen, 0);

  vendorMode = 'rejected';
  const rejected = await call('POST', '/jobs', { prompt: 'Rejected test', request_id: randomUUID() });
  await findJob(rejected.data.id, 'failed');
  assert.equal(billing.publicAccount(billing.payerAccount(db, admin.id)).frozen, 0);

  vendorMode = 'unsubmitted';
  const unsubmitted = await call('POST', '/jobs', { prompt: 'Unsubmitted TLS test', request_id: randomUUID() });
  const tlsFailed = await findJob(unsubmitted.data.id, 'failed');
  assert.match(tlsFailed.error, /生成请求未发送/);
  assert.equal(billing.publicAccount(billing.payerAccount(db, admin.id)).frozen, 0);

  vendorMode = 'lost';
  const lost = await call('POST', '/jobs', { prompt: 'Network lost test', request_id: randomUUID() });
  await findJob(lost.data.id, 'pending_reconciliation');

  // Simulate a process stopping after the provider response became durable.
  const stagedId = randomUUID();
  const stagedRequest = randomUUID();
  const beforeRestart = new Date().toISOString();
  const localKey = db.prepare('SELECT updated_at FROM seed_audio_local_config WHERE id=1').get();
  const stagedAuthorization = billing.createAuthorization(db, admin, {
    service_type: 'audio_generation', model: 'seed-audio-1.0', provider: 'volcengine_voice',
    usage: { millisecond: 120000 }, idempotency_key: 'seed-audio:' + stagedRequest,
    reference_type: 'seed_audio_generation', reference_id: stagedId,
  });
  db.prepare(`INSERT INTO seed_audio_jobs(id,owner_user_id,request_id,prompt,status,key_updated_at,authorization_id,created_at,updated_at)
    VALUES(?,?,?,?,'processing',?,?,?,?)`).run(stagedId, admin.id, stagedRequest, 'Staged audio', localKey.updated_at, stagedAuthorization.authorization_id, beforeRestart, beforeRestart);
  const staging = path.join(storage, '.seed-audio-pending');
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, stagedId + '.json'), JSON.stringify({
    audio: audio.toString('base64'), duration: 1.2, durationMs: 1200, providerId: 'staged-provider-id',
  }));
  await router.close();
  router = null;
  db.close();
  db = new Database(filename);
  require('../src/services/seedAudioService').resume(db, log, cfg);
  router = await startRouter(cfg, db);
  const reopenedConfig = await call('GET', '/config');
  assert.equal(reopenedConfig.status, 200);
  assert.deepEqual(reopenedConfig.data, configuration.data);
  assert.deepEqual(await findJob(first.data.id, 'completed'), completed);
  await findJob(lost.data.id, 'pending_reconciliation');
  assert.ok((await findJob(stagedId, 'completed')).audio_url.startsWith('/static/'));
  assert.equal(submits, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM billing_usage_logs WHERE service_type='audio_generation'").get().n, 2);
});


test('Seed Audio verifies its dedicated TLS connection before constructing the authenticated POST', async (t) => {
  const https = require('node:https');
  const tls = require('node:tls');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const requestId = randomUUID();
  const prompt = '乐器提示词';
  const socket = new PassThrough();
  t.mock.method(tls, 'connect', (options) => {
    assert.equal(options.host, 'openspeech.bytedance.com');
    assert.equal(options.servername, options.host);
    assert.equal(options.port, 443);
    assert.equal(options.rejectUnauthorized, true);
    setImmediate(() => {
      socket.authorized = true;
      socket.emit('secureConnect');
    });
    return socket;
  });
  const requestMock = t.mock.method(https, 'request', (options, onResponse) => {
    assert.equal(options.hostname, 'openspeech.bytedance.com');
    assert.equal(options.path, '/api/v3/tts/create');
    assert.equal(options.createConnection(), socket);
    assert.equal(socket.authorized, true);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Api-Request-Id'], requestId);
    assert.equal(options.headers['X-Api-Key'], 'synthetic-key');
    const outgoing = new EventEmitter();
    outgoing.end = (body) => {
      assert.equal(options.headers['Content-Length'], body.length);
      assert.deepEqual(JSON.parse(body.toString('utf8')), {
        model: 'seed-audio-1.0', text_prompt: prompt, audio_config: { format: 'mp3' },
      });
      const incoming = new PassThrough();
      incoming.statusCode = 200;
      incoming.headers = { 'x-tt-logid': 'simulated-log-id' };
      onResponse(incoming);
      incoming.end('mock-body');
    };
    return outgoing;
  });
  const previousProxy = process.env.SEED_AUDIO_HTTPS_PROXY;
  delete process.env.SEED_AUDIO_HTTPS_PROXY;
  t.after(() => { if (previousProxy !== undefined) process.env.SEED_AUDIO_HTTPS_PROXY = previousProxy; });
  const sent = client.send({ apiKey: 'synthetic-key', requestId, prompt, timeoutMs: 300000 });
  assert.equal(requestMock.mock.callCount(), 0);
  const result = await sent;
  assert.equal(requestMock.mock.callCount(), 1);
  assert.equal(result.ok, true);
  assert.equal(result.headers.get('x-tt-logid'), 'simulated-log-id');
  assert.equal(await new Response(result.body).text(), 'mock-body');
});

test('Seed Audio sends a credential-free CONNECT to the explicit proxy and classifies a TLS failure as unsubmitted', async (t) => {
  const http = require('node:http');
  const https = require('node:https');
  const tls = require('node:tls');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const previousProxy = process.env.SEED_AUDIO_HTTPS_PROXY;
  process.env.SEED_AUDIO_HTTPS_PROXY = 'http://127.0.0.1:7878';
  t.after(() => {
    if (previousProxy === undefined) delete process.env.SEED_AUDIO_HTTPS_PROXY;
    else process.env.SEED_AUDIO_HTTPS_PROXY = previousProxy;
  });
  const tunnel = new PassThrough();
  const connector = t.mock.method(http, 'request', (options) => {
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(Number(options.port), 7878);
    assert.equal(options.method, 'CONNECT');
    assert.equal(options.path, 'openspeech.bytedance.com:443');
    assert.deepEqual(options.headers, { Host: 'openspeech.bytedance.com:443' });
    const outgoing = new EventEmitter();
    outgoing.end = () => outgoing.emit('connect', { statusCode: 200 }, tunnel, Buffer.alloc(0));
    return outgoing;
  });
  t.mock.method(tls, 'connect', (options) => {
    assert.equal(options.socket, tunnel);
    assert.equal(options.servername, 'openspeech.bytedance.com');
    assert.equal(options.rejectUnauthorized, true);
    const socket = new PassThrough();
    setImmediate(() => socket.destroy(Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' })));
    return socket;
  });
  const post = t.mock.method(https, 'request', () => { assert.fail('HTTPS POST happened before verified TLS'); });
  await assert.rejects(client.send({ apiKey: 'synthetic-key', requestId: randomUUID(), prompt: 'fixture', timeoutMs: 1000, proxyUrl: 'http://127.0.0.1:7879' }), {
    code: 'SEED_AUDIO_UNSUBMITTED', phase: 'destination_tls', diagnosticCode: 'ECONNRESET',
  });
  assert.equal(connector.mock.callCount(), 1);
  assert.equal(post.mock.callCount(), 0);
  assert.equal(tunnel.destroyed, true);
});

test('production Seed Audio requires the configured origin and console account, then uses the environment key and retains the published rate', async (t) => {
  const envNames = ['MINIDRAMA_PROFILE', 'SEED_AUDIO_API_KEY', 'SEED_AUDIO_PUBLIC_ORIGIN'];
  const originalEnv = envNames.map((name) => process.env[name]);
  const apiKey = 'synthetic-production-seed-audio-key';
  const origin = 'http://drama.richbest.cn';
  process.env.MINIDRAMA_PROFILE = 'prod';
  delete process.env.SEED_AUDIO_API_KEY;
  process.env.SEED_AUDIO_PUBLIC_ORIGIN = origin;
  loadConfig();

  const temp = mkdtempSync(path.join(tmpdir(), 'richidrama-seed-audio-prod-'));
  const filename = path.join(temp, 'test.db');
  const cfg = { storage: { type: 'local', local_path: path.join(temp, 'storage') }, server: {}, payments: { enabled: false } };
  let db = new Database(filename);
  let router;
  t.after(async () => {
    if (router) await router.close();
    if (db.open) db.close();
    for (const [index, name] of envNames.entries()) {
      if (originalEnv[index] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[index];
    }
    loadConfig();
    rmSync(temp, { recursive: true, force: true });
  });

  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); }
  finally { console.log = originalLog; console.warn = originalWarn; }

  const admin = auth.ensureBootstrapAdmin(db, log);
  const creator = auth.createUser(db, { username: 'prod-audio-creator', password: 'isolated-fixture-pass' }, admin.id);
  const adminSession = auth.issueSession(db, admin).token;
  const creatorSession = auth.issueSession(db, creator).token;
  billing.adjustBalance(db, admin.id, admin.id, 500, 'isolated fixture balance');
  const legacyKey = 'legacy-synthetic-local-key';
  db.prepare('INSERT INTO seed_audio_local_config(id,api_key,updated_at) VALUES(1,?,?)').run(legacyKey, '2026-01-01T00:00:00.000Z');

  const jobs = require('../src/services/seedAudioService');
  router = await startRouter(cfg, db);
  const servicePath = '/tools/audio-generation';
  const proxyHeaders = { host: new URL(origin).host, 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'http', 'x-forwarded-for': '192.0.2.33' };
  const browserHeaders = { ...proxyHeaders, origin, 'sec-fetch-site': 'same-origin' };
  async function call(method, resource, { session = adminSession, headers = browserHeaders, body } = {}) {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    return new Promise((resolve, reject) => {
      const request = require('node:http').request(router.url + servicePath + resource, {
        method, headers: { 'Content-Type': 'application/json', 'X-LMD-Session': session, ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.once('error', reject);
      request.end(payload);
    });
  }

  const audio = toneFixture();
  const sendMock = t.mock.method(client, 'send', async ({ apiKey: credential }) => {
    assert.equal(credential, apiKey);
    return Response.json({ audio: audio.toString('base64'), duration: 1, original_duration: 1.2 }, {
      headers: { 'X-Tt-Logid': 'prod-verified-fixture-logid' },
    });
  });

  jobs.initialize(db, log, cfg);
  assert.equal((await call('GET', '/config')).data.available, false);
  const seededBooks = () => db.prepare("SELECT id,created_at FROM billing_price_books WHERE provider='volcengine_voice' ORDER BY id").all();
  assert.deepEqual(seededBooks(), []);
  process.env.SEED_AUDIO_API_KEY = apiKey;
  process.env.SEED_AUDIO_PUBLIC_ORIGIN = origin + '/invalid/path';
  jobs.initialize(db, log, cfg);
  assert.equal((await call('GET', '/config')).data.available, false);
  assert.deepEqual(seededBooks(), []);
  process.env.SEED_AUDIO_PUBLIC_ORIGIN = origin;
  jobs.initialize(db, log, cfg);
  const booksBefore = seededBooks();
  assert.equal(booksBefore.length, 1);
  jobs.initialize(db, log, cfg);
  assert.deepEqual(seededBooks(), booksBefore);

  const configuration = await call('GET', '/config', { headers: proxyHeaders });
  assert.deepEqual(configuration.data, { available: true, configured: true, max_duration_seconds: 120, rate_credits_per_minute: 100 });
  assert.ok(!JSON.stringify(configuration).includes(apiKey));
  assert.equal((await call('GET', '/config', { session: creatorSession })).data.available, false);

  const body = { prompt: '测试正式环境配乐', request_id: randomUUID() };
  const submit = (options) => call('POST', '/jobs', { body, ...options });
  assert.equal((await submit({ session: creatorSession })).status, 403);
  assert.equal((await submit({ headers: proxyHeaders })).status, 403);
  assert.equal((await submit({ headers: { ...browserHeaders, origin: 'http://other.invalid' } })).status, 403);
  assert.equal((await submit({ headers: { ...browserHeaders, host: 'wrong.invalid' } })).status, 403);
  assert.equal((await submit({ headers: { ...browserHeaders, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(sendMock.mock.callCount(), 0);
  assert.equal((await call('PUT', '/config', { body: { api_key: 'synthetic-replacement-key' } })).status, 404);

  const submitted = await submit();
  assert.equal(submitted.status, 201, JSON.stringify(submitted));
  const id = submitted.data.id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await call('GET', '/jobs', { headers: proxyHeaders });
    if (listed.data.items.some((item) => item.id === id && item.status === 'completed')) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const persisted = db.prepare('SELECT status,key_updated_at,local_path FROM seed_audio_jobs WHERE id=?').get(id);
  assert.equal(persisted.status, 'completed');
  assert.match(persisted.key_updated_at, /^env:[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(path.resolve(cfg.storage.local_path, persisted.local_path)), audio);
  assert.equal(db.prepare('SELECT api_key FROM seed_audio_local_config WHERE id=1').get().api_key, legacyKey);
  assert.equal(sendMock.mock.callCount(), 1);

  await router.close();
  router = null;
  db.close();
  db = new Database(filename);
  jobs.initialize(db, log, cfg);
  router = await startRouter(cfg, db);
  assert.deepEqual((await call('GET', '/config')).data, configuration.data);
  const reread = (await call('GET', '/jobs')).data.items.find((item) => item.id === id);
  assert.equal(reread.status, 'completed');
  assert.deepEqual(seededBooks(), booksBefore);
  assert.equal(sendMock.mock.callCount(), 1);
});
