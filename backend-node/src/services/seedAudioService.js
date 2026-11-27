'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const assets = require('./assetService');
const billing = require('./billingService');
const costLedger = require('./costLedgerService');
const media = require('./mediaAssetService');
const mediaStorage = require('./mediaStorageService');
const seedAudioClient = require('./seedAudioClient');
const { getActiveProfile } = require('../config');
const { getFfmpegPath } = require('../utils/ffmpegPath');
const { resolveStorageFile } = require('../utils/storagePath');

const MODEL = 'seed-audio-1.0';
const SERVICE = 'audio_generation';
const PROVIDER = 'volcengine_voice';
const SOURCE = 'seed_audio_generation';
const MAX_SECONDS = 120;
const MAX_PROMPT = 3000;
const MAX_RESPONSE = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;
const LEASE_MS = REQUEST_TIMEOUT_MS + 60_000;
const RECOVERY_INTERVAL_MS = 5000;
const recoveryTimers = new WeakMap();
const execFileAsync = promisify(execFile);

const now = () => new Date().toISOString();
const canRun = "status IN ('pending','processing','finalizing') AND (lease_until IS NULL OR lease_until<=?)";
const publicSelect = `SELECT j.*, a.duration AS asset_duration, u.charged_micro
  FROM seed_audio_jobs j
  LEFT JOIN assets a ON a.id=j.output_asset_id AND a.owner_user_id=j.owner_user_id AND a.deleted_at IS NULL
  LEFT JOIN billing_usage_logs u ON u.authorization_id=j.authorization_id`;

function requestError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function productionApiKey() {
  const key = process.env.SEED_AUDIO_API_KEY?.trim();
  return /^[\x21-\x7e]{1,512}$/.test(key || '') ? key : null;
}

function productionOrigin() {
  if (getActiveProfile() !== 'prod' || !productionApiKey()) return null;
  try {
    const origin = new URL(process.env.SEED_AUDIO_PUBLIC_ORIGIN || '');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return null;
    return origin;
  } catch (_) { return null; }
}

function readKey(db) {
  if (getActiveProfile() === 'dev') return db.prepare('SELECT api_key,updated_at FROM seed_audio_local_config WHERE id=1').get();
  const apiKey = productionOrigin() && productionApiKey();
  if (!apiKey) return null;
  return { api_key: apiKey, updated_at: `env:${createHash('sha256').update(apiKey).digest('hex')}` };
}

function quoteInput(milliseconds) {
  return { service_type: SERVICE, model: MODEL, provider: PROVIDER, usage: { millisecond: milliseconds } };
}

function configuration(db, actor) {
  const configured = Boolean(readKey(db)?.api_key);
  const result = { configured, max_duration_seconds: MAX_SECONDS };
  if (configured && billing.activeMeters(db, actor, SERVICE, MODEL, PROVIDER).includes('millisecond')) {
    result.rate_credits_per_minute = billing.quote(db, actor, quoteInput(60_000)).amount;
  }
  return result;
}

function view(row) {
  const available = row.status === 'completed' && row.asset_duration != null;
  return {
    id: row.id,
    request_id: row.request_id,
    prompt: row.prompt,
    status: row.status === 'finalizing' ? 'processing' : row.status,
    duration: available ? row.asset_duration : null,
    billed_duration_seconds: row.duration_ms == null ? null : row.duration_ms / 1000,
    local_path: available ? row.local_path : null,
    audio_url: available ? `/static/${row.local_path}` : null,
    asset_id: available ? row.output_asset_id : null,
    charged_credits: row.charged_micro == null ? null : row.charged_micro / 10_000,
    error: row.error_msg,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function list(db, actor) {
  return { items: db.prepare(`${publicSelect} WHERE j.owner_user_id=? ORDER BY j.created_at DESC,j.rowid DESC LIMIT 50`).all(actor.id).map(view) };
}

function create(db, log, cfg, actor, body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const requestId = typeof body?.request_id === 'string' ? body.request_id.trim() : '';
  if (!prompt || [...prompt].length > MAX_PROMPT) {
    throw requestError(400, 'SEED_AUDIO_INVALID_PROMPT', `请填写 1–${MAX_PROMPT} 字的音频提示词`);
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
    throw requestError(400, 'SEED_AUDIO_INVALID_REQUEST_ID', '请提供有效的生成请求 ID');
  }

  const row = db.transaction(() => {
    const existing = db.prepare(`${publicSelect} WHERE j.owner_user_id=? AND j.request_id=?`).get(actor.id, requestId);
    if (existing) {
      if (existing.prompt !== prompt) throw requestError(409, 'SEED_AUDIO_REQUEST_CONFLICT', '请求 ID 已用于不同的音频提示词');
      return existing;
    }
    const key = readKey(db);
    if (!key?.api_key) throw requestError(409, 'SEED_AUDIO_KEY_REQUIRED', '当前环境没有可用的豆包语音配置');
    if (!billing.activeMeters(db, actor, SERVICE, MODEL, PROVIDER).includes('millisecond')) {
      throw requestError(409, 'SEED_AUDIO_PRICE_REQUIRED', '当前账号缺少可用的 Seed Audio 价目');
    }
    const id = randomUUID();
    let authorization;
    try {
      authorization = billing.createAuthorization(db, actor, {
        ...quoteInput(MAX_SECONDS * 1000),
        idempotency_key: `seed-audio:${requestId}`,
        reference_type: SOURCE, reference_id: id,
        source_kind: SOURCE, source_id: id,
      });
    } catch (error) {
      if (error.message === '余额不足') throw requestError(402, 'SEED_AUDIO_INSUFFICIENT_BALANCE', '可用积分不足，单次生成需预留最多 120 秒的积分');
      throw error;
    }
    const at = now();
    db.prepare(`INSERT INTO seed_audio_jobs(id,owner_user_id,request_id,prompt,status,authorization_id,key_updated_at,created_at,updated_at)
      VALUES(?,?,?,?,'pending',?,?,?,?)`).run(id, actor.id, requestId, prompt, authorization.authorization_id, key.updated_at, at, at);
    return db.prepare(`${publicSelect} WHERE j.id=?`).get(id);
  }).immediate();

  if (row.status === 'pending') schedule(db, log, cfg, row.id);
  return view(row);
}

async function boundedJson(response) {
  if (!response.body) throw new Error('空响应');
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > MAX_RESPONSE) throw new Error('响应超过大小上限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
}

async function generate(key, job, log, proxyUrl) {
  let providerId = job.id;
  try {
    const response = await seedAudioClient.send({ apiKey: key, requestId: job.id, prompt: job.prompt, timeoutMs: REQUEST_TIMEOUT_MS, proxyUrl });
    const logId = response.headers.get('x-tt-logid')?.trim();
    if (logId && /^[A-Za-z0-9_. -]{1,128}$/.test(logId) && !logId.includes(key)) providerId = logId;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if ([400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) {
        return { providerId, refused: true, message: `豆包语音拒绝生成请求（HTTP ${response.status}）` };
      }
      return { providerId, message: `豆包语音响应异常（HTTP ${response.status}），等待核对扣费` };
    }
    const result = await boundedJson(response);
    const duration = result?.original_duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS) {
      return { providerId, message: '豆包语音返回的原始音频时长无法用于结算，等待核对扣费' };
    }
    const durationMs = Math.max(1, Math.round(duration * 1000));
    if (typeof result.audio !== 'string' || !result.audio) {
      return { providerId, duration, durationMs, message: '豆包语音未返回可保存的音频，等待核对扣费' };
    }
    const audio = Buffer.from(result.audio, 'base64');
    if (audio.toString('base64') !== result.audio || !media.hasExpectedSignature(audio, 'audio')) {
      return { providerId, duration, durationMs, message: '豆包语音返回的音频内容无法校验，等待核对扣费' };
    }
    return { providerId, duration, durationMs, audio: result.audio };
  } catch (error) {
    if (error?.code === 'SEED_AUDIO_UNSUBMITTED') {
      log?.warn?.('Seed Audio 连接未建立，生成请求未发送', { job_id: job.id, phase: error.phase, network_code: error.diagnosticCode });
      return { refused: true, message: '连接豆包语音失败，生成请求未发送' };
    }
    return { providerId, message: '豆包语音未返回可确认的结果，等待核对扣费' };
  }
}

async function atomicWrite(target, contents) {
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, target);
}

function outcome(db, job, result) {
  const status = result.refused ? 'failed' : 'pending_reconciliation';
  const usage = result.durationMs ? { millisecond: result.durationMs } : undefined;
  const actor = { id: job.owner_user_id };
  db.transaction(() => {
    const updated = db.prepare(`UPDATE seed_audio_jobs SET status=?,provider_request_id=?,duration_ms=?,error_msg=?,updated_at=?
      WHERE id=? AND lease_until=?`).run(status, result.providerId || null, result.durationMs || null, result.message, now(), job.id, job.lease_until);
    if (!updated.changes) return;
    if (result.refused) billing.voidAuthorization(db, actor, job.authorization_id, result.message);
    else billing.markPendingReconciliation(db, actor, job.authorization_id, { reason: result.message, provider_request_id: result.providerId, observed_usage: usage });
    const supplierStatus = result.refused ? 'failed' : usage ? 'completed' : 'unknown';
    costLedger.forAuthorization(db, job.authorization_id, {
      status: supplierStatus, provider_request_id: result.providerId, usage,
      evidence_kind: usage ? 'original_duration' : undefined, reason: result.message,
    });
  })();
}

async function finish(db, log, cfg, job, result, root, stage) {
  const localPath = `seed-audio/${job.id}.mp3`;
  const target = path.join(root, localPath);
  const audio = Buffer.from(result.audio, 'base64');
  await atomicWrite(target, audio);
  const file = resolveStorageFile(root, localPath);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(getFfmpegPath(), [
      '-v', 'error', '-xerror', '-nostdin', '-nostats', '-progress', 'pipe:1', '-f', 'mp3', '-i', file,
      '-map', '0:a:0', '-f', 'null', '-',
    ], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true }));
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    outcome(db, job, { ...result, message: '生成文件无法通过 MP3 播放校验，等待核对扣费' });
    return;
  }
  const lastTime = [...stdout.matchAll(/^out_time_us=(\d+)\s*$/gm)].at(-1);
  const duration = Number(lastTime?.[1]) / 1_000_000;
  if (!(duration > 0)) {
    outcome(db, job, { ...result, message: '生成文件无法通过 MP3 播放校验，等待核对扣费' });
    return;
  }

  const actor = { id: job.owner_user_id };
  const usage = { millisecond: result.durationMs };
  const assetId = db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM seed_audio_jobs WHERE id=? AND status='finalizing' AND lease_until=?").get(job.id, job.lease_until)) return null;
    const asset = assets.create(db, log, {
      owner_user_id: job.owner_user_id, type: 'audio', name: `Seed Audio · ${[...job.prompt].slice(0, 32).join('')}`,
      source_type: SOURCE, local_path: localPath, mime_type: 'audio/mpeg', file_size: audio.length,
      duration, metadata: { codec: 'mp3', seed_audio_job_id: job.id, original_duration: result.duration },
    });
    billing.settleAuthorization(db, actor, job.authorization_id, { usage, provider_request_id: result.providerId });
    db.prepare(`UPDATE seed_audio_jobs SET status='completed',local_path=?,output_asset_id=?,error_msg=NULL,updated_at=?
      WHERE id=? AND lease_until=?`).run(localPath, asset.id, now(), job.id, job.lease_until);
    return asset.id;
  })();

  if (assetId) {
    // This temporary response has served its purpose once the verified asset and ledger are durable.
    await fs.unlink(stage).catch(() => {});
    if (mediaStorage.isOss(cfg)) {
      try { await mediaStorage.mirrorAndTrack(db, cfg, root, localPath, 'asset', assetId, log, { contentType: 'audio/mpeg' }); }
      catch (_) { log?.warn?.('Seed Audio 媒体镜像待重试', { asset_id: assetId }); }
    }
  }
}

async function processJob(db, log, cfg, id) {
  if (!db.open) return;
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  if (!db.prepare(`UPDATE seed_audio_jobs SET lease_until=? WHERE id=? AND ${canRun}`).run(lease, id, now()).changes) return;
  const job = db.prepare('SELECT * FROM seed_audio_jobs WHERE id=?').get(id);
  const root = media.resolveStoragePath(cfg);
  const staging = path.join(root, '.seed-audio-pending');
  const stage = path.join(staging, `${id}.json`);

  try {
    let result;
    if (job.status === 'pending') {
      const key = readKey(db);
      if (!key?.api_key || key.updated_at !== job.key_updated_at) {
        outcome(db, job, { refused: true, message: '豆包语音 API Key 已更换，请重新发起生成' });
        return;
      }
      try {
        await fs.mkdir(staging, { recursive: true, mode: 0o700 });
        await fs.mkdir(path.join(root, 'seed-audio'), { recursive: true });
      } catch (_) {
        outcome(db, job, { refused: true, message: '本地音频存储不可用，生成请求尚未发送' });
        return;
      }
      const dispatched = db.transaction(() => {
        if (readKey(db)?.updated_at !== job.key_updated_at) return false;
        const changed = db.prepare("UPDATE seed_audio_jobs SET status='processing',updated_at=? WHERE id=? AND status='pending' AND lease_until=?")
          .run(now(), id, lease).changes;
        if (changed) costLedger.begin(db, { service_type: SERVICE, model: MODEL, config: { provider: PROVIDER }, authorization_id: job.authorization_id });
        return Boolean(changed);
      }).immediate();
      if (!dispatched) {
        outcome(db, job, { refused: true, message: '豆包语音 API Key 已更换，请重新发起生成' });
        return;
      }
      result = await generate(key.api_key, job, log, cfg?.server?.egress_proxy);
      if (!db.open) return;
      if (!result.audio) {
        outcome(db, job, result);
        return;
      }
      try { await atomicWrite(stage, JSON.stringify(result)); }
      catch (_) {
        outcome(db, job, { ...result, message: '生成结果暂无法写入本地存储，等待核对扣费' });
        return;
      }
    } else {
      try { result = JSON.parse(await fs.readFile(stage, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        outcome(db, job, { providerId: job.provider_request_id || id, durationMs: job.duration_ms, message: '进程中断后缺少生成结果，等待核对扣费' });
        return;
      }
    }

    const started = db.prepare(`UPDATE seed_audio_jobs SET status='finalizing',provider_request_id=?,duration_ms=?,updated_at=?
      WHERE id=? AND lease_until=?`).run(result.providerId, result.durationMs, now(), id, lease).changes;
    if (!started) return;
    costLedger.forAuthorization(db, job.authorization_id, { status: 'completed', provider_request_id: result.providerId, usage: { millisecond: result.durationMs }, evidence_kind: 'original_duration' });
    try { await finish(db, log, cfg, job, result, root, stage); }
    catch (error) {
      if (!db.open) return;
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' && error.message.includes('billing_usage_logs.provider_request_id')) {
        outcome(db, job, { ...result, message: '豆包语音返回了已结算的请求标识，本次积分等待核对' });
        return;
      }
      if (error.code?.startsWith('BILLING_')) {
        outcome(db, job, { ...result, message: '已取得生成音频，积分结算等待核对' });
        return;
      }
      db.prepare('UPDATE seed_audio_jobs SET error_msg=?,updated_at=? WHERE id=? AND lease_until=?')
        .run('本地音频归档暂未完成，系统将继续恢复', now(), id, lease);
      log?.warn?.('Seed Audio 本地归档待重试', { job_id: id });
    }
  } finally {
    if (db.open) db.prepare('UPDATE seed_audio_jobs SET lease_until=NULL WHERE id=? AND lease_until=?').run(id, lease);
  }
}

function schedule(db, log, cfg, id) {
  setImmediate(() => processJob(db, log, cfg, id).catch(() => log?.warn?.('Seed Audio 任务处理暂未完成', { job_id: id })));
}

function resume(db, log, cfg) {
  if (recoveryTimers.has(db)) return;
  const poll = () => {
    if (!db.open) {
      clearInterval(recoveryTimers.get(db));
      recoveryTimers.delete(db);
      return;
    }
    try {
      for (const row of db.prepare(`SELECT id FROM seed_audio_jobs WHERE ${canRun} ORDER BY created_at LIMIT 20`).all(now())) {
        schedule(db, log, cfg, row.id);
      }
    } catch (_) { log?.warn?.('Seed Audio 恢复扫描暂不可用'); }
  };
  const timer = setInterval(poll, RECOVERY_INTERVAL_MS);
  timer.unref();
  recoveryTimers.set(db, timer);
  poll();
}

function initialize(db, log, cfg) {
  if (getActiveProfile() !== 'dev') {
    if (!productionOrigin()) return;
    db.transaction(() => {
      const at = now();
      db.prepare(`INSERT OR IGNORE INTO ai_model_catalog(service_type,model,display_name,status,created_at,updated_at)
        VALUES(?,?,'豆包音频生成模型 1.0','active',?,?)`).run(SERVICE, MODEL, at, at);
      const existing = db.prepare(`SELECT 1 FROM billing_price_book_items i JOIN billing_price_books b ON i.price_book_id=b.id
        WHERE b.owner_user_id IS NULL AND i.service_type=? AND i.model=? AND i.meter='millisecond'
          AND (b.status='published' OR (b.status='archived' AND b.provider=?)) LIMIT 1`).get(SERVICE, MODEL, PROVIDER);
      if (existing) return;
      const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND console_access=1 AND is_active=1 ORDER BY id LIMIT 1").get();
      if (!admin) return;
      billing.savePriceBook(db, admin.id, {
        name: 'Seed Audio 音频生成', provider: PROVIDER, status: 'published',
        items: [{ service_type: SERVICE, model: MODEL, meter: 'millisecond', unit_price: 100, conditions_json: { unit_size: 60_000 } }],
      });
    }).immediate();
  }
  resume(db, log, cfg);
}

module.exports = { productionOrigin, configuration, create, list, initialize, resume };
