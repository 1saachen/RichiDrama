'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { resolveStorageFile } = require('../utils/storagePath');
const { getFfprobePath } = require('../utils/ffmpegPath');
const { runMediaProcess, resolveStoragePath } = require('./mediaAssetService');
const { parseFps } = require('./videoMediaProbeService');
const { BILLING_MODEL, validateOutput } = require('./videoUpscaleService');
const { fpsTier } = require('./videoInterpolationService');
const client = require('./videoUpscaleClient');
const billing = require('./billingService');
const cost = require('./costLedgerService');

const TYPE = 'video_postprocess';
const SOURCE = 'standalone_video_upscale';
const PROVIDER = 'volcengine_mediakit';
const TABLE = 'standalone_video_upscale_jobs';
const TARGETS = ['720p', '1080p'];
const POLL_MS = 5000;
const LEASE_MS = 180_000;
const TIMEOUT_MS = 2 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const shortEdge = ({ width, height }) => Math.min(width, height);

async function probe(file) {
  const { stdout } = await runMediaProcess(getFfprobePath(), [
    '-v', 'error', '-protocol_whitelist', 'file', '-show_entries',
    'format=duration,format_name:stream=codec_type,width,height,avg_frame_rate,color_transfer:stream_side_data=rotation:stream_disposition=attached_pic',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration_ms = Math.round(Number(data.format?.duration) * 1000);
  const fps = parseFps(stream?.avg_frame_rate);
  if (!data.format?.format_name?.split(',').includes('mp4') || !stream?.width || !stream.height
      || !Number.isSafeInteger(duration_ms) || duration_ms <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('请选择可以读取的 MP4 或 MOV 视频');
  }
  const rotation = Number(stream.side_data_list?.find((item) => item.rotation != null)?.rotation || 0);
  const swap = Math.abs(rotation % 180) === 90;
  return {
    width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height,
    fps, duration_ms, audio: data.streams.some((s) => s.codec_type === 'audio'),
    hdr: ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer),
  };
}

function targets(media) {
  return TARGETS.filter((target) => shortEdge(media) < Number.parseInt(target, 10));
}

function owned(db, actor, id) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id=? AND id=?`).get(actor.id, id);
}

function publicJob(row) {
  const source = JSON.parse(row.source_media_json);
  return {
    id: row.id, name: row.original_name, status: row.status, source,
    targets: targets(source), target_resolution: row.target_resolution,
    output: row.output_media_json ? JSON.parse(row.output_media_json) : null,
    error: row.error_msg, created_at: row.created_at,
  };
}

function list(db, actor, before) {
  const anchor = before ? owned(db, actor, before) : null;
  if (before && !anchor) return { items: [], next: null };
  const query = `SELECT * FROM ${TABLE} WHERE owner_user_id=?`;
  const order = ' ORDER BY created_at DESC, id DESC LIMIT 21';
  const rows = anchor
    ? db.prepare(query + ' AND (created_at, id) < (?, ?)' + order).all(actor.id, anchor.created_at, anchor.id)
    : db.prepare(query + order).all(actor.id);
  return { items: rows.slice(0, 20).map(publicJob), next: rows.length > 20 ? rows[19].id : null };
}

async function importVideo(db, cfg, actor, file, originalName) {
  if (!file) throw new Error('请选择要超分的视频');
  const ext = path.extname(file.originalname).toLowerCase();
  if (!['.mp4', '.mov'].includes(ext)) throw new Error('请选择 MP4 或 MOV 视频');
  let media;
  try { media = await probe(file.path); }
  catch (_) { throw new Error('无法读取视频，请重新导出为 MP4 或 MOV 后上传'); }
  if (shortEdge(media) < 360 || Math.max(media.width, media.height) > 1920 || !targets(media).length) {
    throw new Error('视频短边需为 360–1079 像素，长边不能超过 1920 像素');
  }
  if (media.hdr || media.fps > 120) throw new Error('请选择 SDR 视频，帧率最高为 120 fps');

  const id = randomUUID();
  const relative = `standalone-upscale/${id}/source${ext}`;
  const absolute = path.join(resolveStoragePath(cfg), relative);
  const name = String(originalName || file.originalname).split(/[/\\]/).pop().replace(/[\u0000-\u001f]/g, '').slice(0, 200) || `视频${ext}`;
  const at = now();
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.renameSync(file.path, absolute);
  try {
    db.prepare(`INSERT INTO ${TABLE}(id, owner_user_id, original_name, source_path, source_media_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`).run(id, actor.id, name, relative, JSON.stringify(media), at, at);
  } catch (error) {
    fs.rmSync(absolute, { force: true });
    throw error;
  }
  return publicJob(owned(db, actor, id));
}

function providerConfig(db, actor, id) {
  const tenant = require('./tenantService').tenantForUser(db, actor.id);
  const row = require('./aiConfigService').listConfigs(db, TYPE, { tenant_id: tenant?.id }).find((item) =>
    item.is_active && item.provider === PROVIDER && item.api_key && item.model.includes(BILLING_MODEL) &&
      (!id || item.id === id) && (!item.owner_tenant_id || item.owner_tenant_id === tenant?.id));
  if (!row) throw new Error('当前账户尚未配置可用的视频超分服务');
  return client.config(db, row);
}

function fingerprint(config) {
  return createHash('sha256').update(JSON.stringify([config.base_url, config.api_key, config.settings.queue_id])).digest('hex');
}

function priceInput(row, target, config) {
  const source = JSON.parse(row.source_media_json);
  if (!targets(source).includes(target)) throw new Error('请选择高于原视频规格的目标分辨率');
  return {
    service_type: TYPE, model: config.billing_key || BILLING_MODEL, provider_model: BILLING_MODEL, provider: 'volcengine',
    usage: { millisecond: source.duration_ms },
    pricing_context: { resolution_tier: target, fps_tier: fpsTier(source.fps) },
    reference_type: SOURCE, reference_id: row.id,
    idempotency_key: `${SOURCE}:${row.id}`,
  };
}

function quote(db, actor, row, target) {
  if (row.status !== 'ready') throw new Error('该视频已提交超分');
  const config = providerConfig(db, actor);
  const priced = billing.quote(db, actor, priceInput(row, target, config));
  return { amount: priced.amount, amount_micro: priced.amount_micro };
}

function submit(db, cfg, actor, row, body) {
  return db.transaction(() => {
    const current = owned(db, actor, row.id);
    if (current.status !== 'ready') {
      if (current.target_resolution !== body.target_resolution) throw new Error('该视频已按其他分辨率提交超分');
      return publicJob(current);
    }
    resolveStorageFile(resolveStoragePath(cfg), current.source_path);
    const config = providerConfig(db, actor);
    const input = priceInput(current, body.target_resolution, config);
    const authorization = billing.createAuthorization(db, actor, input);
    if (authorization.amount_micro !== body.amount_micro) throw new Error('积分报价已更新，请重新获取报价后确认');
    db.prepare(`UPDATE ${TABLE} SET status='queued', target_resolution=?, authorization_id=?, config_id=?, config_fingerprint=?, updated_at=?
      WHERE id=?`).run(body.target_resolution, authorization.authorization_id, config.id, fingerprint(config), now(), current.id);
    return publicJob(owned(db, actor, current.id));
  }).immediate();
}

function reconcile(db, row, message) {
  db.transaction(() => {
    billing.markPendingReconciliation(db, { id: row.owner_user_id }, row.authorization_id, {
      provider_request_id: row.provider_request_id || row.provider_task_id, reason: message,
    });
    db.prepare(`UPDATE ${TABLE} SET status='reconciliation', error_msg=?, updated_at=? WHERE id=?`).run(message, now(), row.id);
  })();
}

function fail(db, row, message) {
  db.transaction(() => {
    billing.voidAuthorization(db, { id: row.owner_user_id }, row.authorization_id, message);
    db.prepare(`UPDATE ${TABLE} SET status='failed', error_msg=?, updated_at=? WHERE id=?`).run(message, now(), row.id);
  })();
}

async function archive(cfg, row, url) {
  const relative = `standalone-upscale/${row.id}/result.mp4`;
  const root = resolveStoragePath(cfg);
  const absolute = path.join(root, relative);
  const temp = `${absolute}.part`;
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) throw new Error(`超分结果下载失败（HTTP ${response.status}）`);
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    const source = JSON.parse(row.source_media_json);
    let output;
    try {
      output = await probe(temp);
      validateOutput(source, output, row.target_resolution);
      if (shortEdge(output) <= shortEdge(source) || fpsTier(output.fps) !== fpsTier(source.fps)
          || (source.audio && !output.audio) || Math.abs(output.duration_ms - source.duration_ms) > Math.max(500, source.duration_ms * 0.02)) {
        throw new Error('成片的分辨率、帧率、音轨或时长未通过校验');
      }
    } catch (error) {
      error.code = 'INVALID_UPSCALE_OUTPUT';
      throw error;
    }
    fs.renameSync(temp, absolute);
    return { relative, output };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function complete(db, row, { relative, output }, providerRequestId) {
  const usage = { millisecond: output.duration_ms };
  cost.forAuthorization(db, row.authorization_id, { status: 'completed', usage, evidence_kind: 'verified_local_media_duration' });
  db.transaction(() => {
    db.prepare(`UPDATE ${TABLE} SET output_path=?, output_media_json=?, provider_request_id=?, updated_at=? WHERE id=?`)
      .run(relative, JSON.stringify(output), providerRequestId, now(), row.id);
    try {
      billing.settleAuthorization(db, { id: row.owner_user_id }, row.authorization_id, { usage, provider_request_id: providerRequestId });
    } catch (error) {
      if (!['BILLING_ACTUAL_USAGE_EXCEEDS_AVAILABLE_BALANCE', 'BILLING_FROZEN_BALANCE_MISMATCH'].includes(error.code)) throw error;
      reconcile(db, { ...row, provider_request_id: providerRequestId }, '成片已归档，等待管理员核对计费');
      return;
    }
    db.prepare(`UPDATE ${TABLE} SET status='completed', error_msg=NULL WHERE id=?`).run(row.id);
  })();
}

function syncReconciled(db) {
  db.prepare(`UPDATE ${TABLE} AS j SET
    status=CASE WHEN j.output_path IS NOT NULL AND c.status IN ('resolved','waived') THEN 'completed' ELSE 'failed' END,
    error_msg=CASE WHEN j.output_path IS NOT NULL AND c.status IN ('resolved','waived') THEN NULL ELSE '对账已结束，成片不可用' END,
    updated_at=?
    FROM billing_reconciliation_cases c
    WHERE j.status='reconciliation' AND c.authorization_id=j.authorization_id AND c.status IN ('resolved','waived','expired')`).run(now());
}

async function processJob(db, log, cfg, id) {
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  if (!db.prepare(`UPDATE ${TABLE} SET lease_until=? WHERE id=? AND status IN ('queued','submitting','processing')
      AND (lease_until IS NULL OR lease_until<?)`).run(lease, id, now()).changes) return;
  let row;
  try {
    row = db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id);
    if (row.status === 'submitting') return reconcile(db, row, '超分提交结果待核实，请等待管理员对账');
    if (row.status === 'processing') {
      const relative = `standalone-upscale/${id}/result.mp4`;
      const root = resolveStoragePath(cfg);
      if (fs.existsSync(path.join(root, relative))) {
        const output = await probe(resolveStorageFile(root, relative));
        return complete(db, row, { relative, output }, row.provider_request_id || row.provider_task_id);
      }
    }
    if (row.status === 'processing' && Date.now() - Date.parse(row.submitted_at) > TIMEOUT_MS) {
      return reconcile(db, row, '超分处理或归档超时，请等待管理员对账');
    }
    const actor = { id: row.owner_user_id };
    const config = providerConfig(db, actor, row.config_id);
    if (fingerprint(config) !== row.config_fingerprint) throw new Error('超分服务配置已变更');
    if (row.status === 'queued') {
      const input = priceInput(row, row.target_resolution, config);
      require('./modelCatalogService').assertAvailable(db, TYPE, BILLING_MODEL);
      const authorization = billing.getAuthorization(db, row.authorization_id);
      const file = resolveStorageFile(resolveStoragePath(cfg), row.source_path);
      const uploaded = await client.uploadLocalVideo(db, file, config, AbortSignal.timeout(75_000));
      db.prepare(`UPDATE ${TABLE} SET status='submitting', provider_request_id=?, updated_at=? WHERE id=?`).run(uploaded.request_id, now(), id);
      row.status = 'submitting';
      row.provider_request_id = uploaded.request_id;
      const result = await cost.track(db, {
        config, model: BILLING_MODEL, service_type: TYPE, authorization_id: row.authorization_id,
        operation_id: authorization.snapshot.cost_operation_id || row.authorization_id,
        user_id: actor.id, pricing_context: { resolution: row.target_resolution, ...input.pricing_context },
      }, () => client.submit(db, {
        video_url: uploaded.file_id, resolution: row.target_resolution, client_token: `standalone-up-${id}`,
      }, config, AbortSignal.timeout(20_000)), (accepted) => ({
        status: 'processing', provider_task_id: accepted.task_id, provider_request_id: accepted.request_id, usage: { request: 1 },
      }));
      const at = now();
      db.prepare(`UPDATE ${TABLE} SET status='processing', provider_task_id=?, provider_request_id=COALESCE(?,provider_request_id),
        submitted_at=?, updated_at=? WHERE id=?`).run(result.task_id, result.request_id, at, at, id);
      return;
    }
    const result = await client.retrieve(db, row.provider_task_id, config, AbortSignal.timeout(15_000));
    if (result.status === 'failed') return fail(db, row, '超分服务处理失败，已释放预授权');
    if (result.status !== 'completed' || !result.result?.video_url) {
      db.prepare(`UPDATE ${TABLE} SET updated_at=?, error_msg=NULL WHERE id=?`).run(now(), id);
      return;
    }
    const providerRequestId = result.request_id || row.provider_request_id || row.provider_task_id;
    db.prepare(`UPDATE ${TABLE} SET provider_request_id=? WHERE id=?`).run(providerRequestId, id);
    row.provider_request_id = providerRequestId;
    complete(db, row, await archive(cfg, row, result.result.video_url), providerRequestId);
  } catch (error) {
    log.warn('Standalone video upscale step failed', { id, status: row?.status, error_code: error.code || error.name });
    if (row?.status === 'queued') fail(db, row, '超分未提交，已释放预授权');
    else if (row?.status === 'submitting') reconcile(db, row, '超分提交结果待核实，请等待管理员对账');
    else if (error.code === 'INVALID_UPSCALE_OUTPUT') reconcile(db, row, '成片规格未通过校验，请等待管理员对账');
    else if (row?.status === 'processing') {
      db.prepare(`UPDATE ${TABLE} SET error_msg=?, updated_at=? WHERE id=?`).run('正在重新查询或归档超分结果', now(), id);
    }
  } finally {
    db.prepare(`UPDATE ${TABLE} SET lease_until=NULL WHERE id=? AND lease_until=?`).run(id, lease);
  }
}

function resume(db, log, cfg) {
  let busy = false;
  let stopped = false;
  async function sweep() {
    if (busy || stopped) return;
    busy = true;
    try {
      syncReconciled(db);
      const jobs = db.prepare(`SELECT id FROM ${TABLE} WHERE status IN ('queued','submitting','processing')
        AND (lease_until IS NULL OR lease_until<?) ORDER BY updated_at, created_at LIMIT 12`).all(now());
      await Promise.allSettled(jobs.map(({ id }) => processJob(db, log, cfg, id))).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') log.error('Standalone video upscale recovery failed', { error_code: result.reason?.code });
        }
      });
    } catch (error) {
      log.error('Standalone video upscale sweep failed', { error_code: error.code });
    } finally { busy = false; }
  }
  const timer = setInterval(sweep, POLL_MS);
  timer.unref();
  setImmediate(sweep);
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
  };
}

module.exports = { importVideo, owned, publicJob, list, quote, submit, resume };
