const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const MODEL = 'doubao-seedance-2-5-260628';
const CUTOFF = Date.parse('2026-10-28T10:00:00+08:00');
const parse = value => { try { return JSON.parse(value || '{}'); } catch (_) { return {}; } };

function installed(db) {
  return !!db?.prepare?.("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_draft_tasks'")?.get?.();
}
function record(db, id) {
  return installed(db) ? db.prepare('SELECT * FROM video_draft_tasks WHERE generation_id=?').get(Number(id)) : null;
}
function isDraft(db, id) { return record(db, id)?.stage === 'draft'; }
function normalPredicate(db, alias = 'video_generations') {
  return installed(db) ? `NOT EXISTS (SELECT 1 FROM video_draft_tasks vd WHERE vd.generation_id=${alias}.id AND vd.stage='draft')` : '1=1';
}
function fingerprint(config) {
  return createHash('sha256').update(JSON.stringify([config.provider, config.base_url, config.endpoint, config.api_protocol, config.api_key])).digest('hex');
}
function assertConfig(config, model) {
  if (model !== MODEL || !['volcengine', 'volces', 'volc'].includes(String(config?.provider || '').toLowerCase())) {
    throw new Error('样片模式仅支持火山官方 Seedance 2.5');
  }
  const url = new URL(config.base_url);
  const testOnly = process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname) && config.api_key === 'mock-only';
  if (url.hostname !== 'ark.cn-beijing.volces.com' && !testOnly) throw new Error('当前渠道未验证样片协议，请选择火山官方配置');
}
function assertPinnedConfig(db, id, config, model) {
  const meta = record(db, id);
  if (!meta) return;
  assertConfig(config, model);
  if (fingerprint(config) !== meta.config_fingerprint || config.is_active === 0) throw new Error('原样片供应商配置已改变或停用，已停止调用');
}
function capability(db, body, actor) {
  if (body.model !== MODEL) throw new Error('请选择官方 Seedance 2.5 模型生成样片');
  const tenant = require('./tenantService').tenantForUser(db, actor.id);
  const options = tenant?.id ? { tenant_id: tenant.id } : {};
  const cap = require('./videoModelCapabilities').resolve(db, body.model, [], options);
  const config = require('./aiConfigService').getConfig(db, cap.config_id);
  assertConfig(config, cap.model);
  if (cap.model !== body.model) throw new Error('所选样片模型不可用');
  return { config, cap };
}
function expiry(createdAt) {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? new Date(created + (created >= CUTOFF ? 14 : 7) * 86400000).toISOString() : null;
}
function localFile(row) {
  if (!row?.local_path || row.status !== 'completed') return false;
  try {
    const cfg = require('../config').loadConfig();
    const root = require('node:path').resolve(cfg.storage?.local_path || './data/storage');
    const file = require('../utils/storagePath').resolveStorageFile(root, row.local_path);
    return fs.statSync(file).size > 0;
  } catch (_) { return false; }
}
function summary(db, row) {
  const meta = record(db, row.id);
  if (!meta) return {};
  const final = db.prepare('SELECT d.generation_id,v.status,v.local_path,v.provider_task_id FROM video_draft_tasks d JOIN video_generations v ON v.id=d.generation_id WHERE d.source_generation_id=?').get(row.id);
  let points = null;
  try { points = db.prepare('SELECT charged_micro / 10000.0 amount FROM billing_usage_logs WHERE authorization_id=?').get(row.billing_authorization_id)?.amount ?? null; } catch (_) {}
  const expired = meta.stage === 'draft' && (!meta.expires_at || Date.now() >= Date.parse(meta.expires_at));
  return { generation_mode: meta.stage, draft_source_generation_id: meta.source_generation_id,
    draft_expires_at: meta.expires_at, draft_expired: expired, final_generation_id: final?.generation_id || null,
    draft_can_finalize: meta.stage === 'draft' && !expired && meta.provider_draft !== 0 && !final && localFile(row),
    draft_can_recover: !!row.provider_task_id && (row.status === 'failed' || (row.status === 'completed' && !localFile(row))),
    final_status: final?.status || null, final_can_recover: !!final?.provider_task_id && final.status === 'failed',
    actual_points: points, archive_status: row.archive_status || (row.local_path ? 'local' : null) };
}
function capture(db, id, data) {
  const meta = record(db, id);
  if (meta?.stage !== 'draft') return;
  const createdValue = data?.created_at ?? data?.data?.created_at;
  const created = typeof createdValue === 'number' && Number.isFinite(createdValue) ? new Date(createdValue * 1000).toISOString() : meta.provider_created_at || meta.created_at;
  let until = expiry(created);
  const shorter = Number(data?.draft_expires_at ?? data?.data?.draft_expires_at);
  if (Number.isFinite(shorter) && shorter > 0 && shorter * 1000 < Date.parse(until)) until = new Date(shorter * 1000).toISOString();
  if (meta.expires_at && Date.parse(meta.expires_at) < Date.parse(until)) until = meta.expires_at;
  const flag = data?.draft ?? data?.data?.draft;
  const row = db.prepare('SELECT billing_authorization_id FROM video_generations WHERE id=?').get(id);
  const context = row?.billing_authorization_id ? require('./billingService').getAuthorization(db, row.billing_authorization_id)?.snapshot?.pricing_context : null;
  db.prepare('UPDATE video_draft_tasks SET provider_created_at=?, expires_at=?, provider_draft=COALESCE(?,provider_draft),has_video_input=?,has_audio_input=? WHERE generation_id=?')
    .run(created, until, typeof flag === 'boolean' ? Number(flag) : null, context ? Number(!!context.has_video_input) : meta.has_video_input, context ? Number(!!context.has_audio) : meta.has_audio_input, id);
}
function quote(db, body, actor) {
  capability(db, body, actor);
  return require('./omniVideoService').quote(db, { ...body, draft_mode: true, resolution: '480p', upscale_resolution: null, target_fps: null }, actor);
}
function create(db, log, body, actor) {
  if (body.source_context === 'creative_board') throw new Error('画布样片入口尚未开放，请在镜头工作台生成');
  if (body.audio_strategy === 'post_mix') throw new Error('样片模式暂不支持本地成片混音，请选择音频参考');
  if (!installed(db)) throw new Error('样片数据结构尚未初始化');
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw new Error('样片请求缺少幂等键');
  const requestKey = `draft:${actor.id}:${key}`;
  const prior = db.prepare('SELECT generation_id FROM video_draft_tasks WHERE request_key=?').get(requestKey);
  if (prior) return result(db, prior.generation_id, actor);
  const { config } = capability(db, body, actor);
  return db.transaction(() => {
    const linked = db.prepare('SELECT generation_id FROM video_draft_tasks WHERE request_key=?').get(requestKey);
    if (linked) return result(db, linked.generation_id, actor);
    if (body.drama_id && !require('./projectAccessService').access(db, body.drama_id, actor.id)?.can_edit) throw new Error('没有项目编辑权限');
    const storyboard = body.storyboard_id ? db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(Number(body.storyboard_id)) : null;
    if (body.storyboard_id && (!storyboard || Number(storyboard.drama_id || db.prepare('SELECT drama_id FROM episodes WHERE id=?').get(storyboard.episode_id)?.drama_id) !== Number(body.drama_id))) throw new Error('分镜不属于当前项目');
    const shot = body.shot_id ? db.prepare('SELECT * FROM omni_video_sequence_shots WHERE id=? AND sequence_id=? AND deleted_at IS NULL').get(Number(body.shot_id), Number(body.sequence_id)) : null;
    if (body.shot_id && !shot) throw new Error('镜头不属于当前序列');
    const out = require('./omniVideoService').create(db, log, { ...body, draft_mode: true,
      owner_user_id: actor.id, model: MODEL, resolution: '480p', upscale_resolution: null, target_fps: null }, actor);
    const generation = db.prepare('SELECT billing_authorization_id FROM video_generations WHERE id=?').get(out.video_generation_id);
    const context = generation.billing_authorization_id
      ? require('./billingService').getAuthorization(db, generation.billing_authorization_id)?.snapshot?.pricing_context || {}
      : parse(db.prepare('SELECT request_snapshot_json FROM omni_video_jobs WHERE id=?').get(out.omni_job_id)?.request_snapshot_json);
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO video_draft_tasks (generation_id,stage,request_key,config_id,config_fingerprint,has_video_input,has_audio_input,expires_at,created_at)
      VALUES (?,'draft',?,?,?,?,?,?,?)`).run(out.video_generation_id, requestKey, config.id, fingerprint(config),
      context.has_video_input ? 1 : 0, context.has_audio ? 1 : 0, expiry(at), at);
    db.prepare('UPDATE video_generations SET ai_config_id=? WHERE id=?').run(config.id, out.video_generation_id);
    if (storyboard) db.prepare('UPDATE storyboards SET active_video_generation_id=?,status=?,error_msg=?,updated_at=? WHERE id=?')
      .run(storyboard.active_video_generation_id, storyboard.status, storyboard.error_msg, storyboard.updated_at, storyboard.id);
    if (shot) db.prepare('UPDATE omni_video_sequence_shots SET omni_job_id=?,settings_json=?,updated_at=? WHERE id=?')
      .run(shot.omni_job_id, shot.settings_json, shot.updated_at, shot.id);
    return { ...out, generation_mode: 'draft' };
  }).immediate();
}
function source(db, id, actor) {
  const row = db.prepare('SELECT * FROM video_generations WHERE id=?').get(Number(id));
  const meta = row && record(db, row.id);
  if (!row || row.deleted_at || Number(row.owner_user_id) !== Number(actor.id) || meta?.stage !== 'draft') throw new Error('样片不存在或无权访问');
  if (row.drama_id && !require('./projectAccessService').access(db, row.drama_id, actor.id)?.can_edit) throw new Error('没有项目编辑权限');
  return { row, meta };
}
function promotion(db, id, actor) {
  const { row, meta } = source(db, id, actor);
  if (!localFile(row) || !row.provider_task_id) throw new Error('样片尚未完成本地归档');
  if (meta.provider_draft === 0) throw new Error('供应商明确返回非样片结果，不能升级');
  if (!meta.expires_at || Date.now() >= Date.parse(meta.expires_at)) throw new Error('样片升级有效期已结束，本地预览仍可保留');
  const config = require('./aiConfigService').getConfig(db, meta.config_id);
  assertConfig(config, row.model);
  if (fingerprint(config) !== meta.config_fingerprint || config.is_active === 0) throw new Error('原供应商配置已改变或停用，不能升级此样片');
  const billing = require('./billingService');
  const target = require('./aiConfigService').resolveBillingTarget(db, 'video', row.model, config.id, row.tenant_id ? { tenant_id: row.tenant_id } : {});
  const meters = billing.activeMeters(db, actor, 'video', target.billing_key, target.provider);
  const usage = require('./omniVideoService').buildAuthorizationUsage(meters, parse(config.settings), row.duration,
    { model: target.provider_model, resolution: '1080p', aspect_ratio: row.aspect_ratio, has_video_input: !!meta.has_video_input, requested_duration: row.duration });
  if (!Object.keys(usage).length) throw new Error('正式视频没有可用价目');
  const context = { has_video_input: !!meta.has_video_input, has_audio: !!meta.has_audio_input, resolution: '1080p', generation_mode: 'draft_final' };
  return { row, meta, config, target, usage, context };
}
function quoteFinal(db, id, actor) {
  const p = promotion(db, id, actor);
  return require('./billingService').quote(db, actor, { service_type: 'video', model: p.target.billing_key,
    provider_model: p.target.provider_model, provider: p.target.provider, usage: p.usage, pricing_context: p.context });
}
function result(db, id, actor) {
  const row = db.prepare('SELECT * FROM video_generations WHERE id=?').get(Number(id));
  if (!row || Number(row.owner_user_id) !== Number(actor.id)) throw new Error('任务不存在');
  const job = db.prepare('SELECT id FROM omni_video_jobs WHERE video_generation_id=? ORDER BY id DESC LIMIT 1').get(row.id);
  return { ...require('./videoService').getById(db, id), ...summary(db, row), omni_job_id: job?.id || null, video_generation_id: row.id };
}
function finalize(db, log, id, actor) {
  const { row: original } = source(db, id, actor);
  const existing = db.prepare('SELECT generation_id FROM video_draft_tasks WHERE source_generation_id=?').get(original.id);
  if (existing) return result(db, existing.generation_id, actor);
  const p = promotion(db, id, actor);
  const sourceJob = db.prepare('SELECT sequence_id,shot_id FROM omni_video_jobs WHERE video_generation_id=? ORDER BY id DESC LIMIT 1').get(p.row.id);
  if (require('./generationSubmissionGuard').findActiveVideoForTarget(db, { ownerUserId: actor.id, storyboardId: p.row.storyboard_id, sequenceId: sourceJob?.sequence_id, shotId: sourceJob?.shot_id })) throw new Error('当前镜头已有生成任务');
  return db.transaction(() => {
    const linked = db.prepare('SELECT generation_id FROM video_draft_tasks WHERE source_generation_id=?').get(original.id);
    if (linked) return result(db, linked.generation_id, actor);
    const auth = require('./billingService').createAuthorization(db, actor, {
      idempotency_key: `video-draft-final:${p.row.id}`, service_type: 'video', model: p.target.billing_key,
      provider_model: p.target.provider_model, provider: p.target.provider, usage: p.usage, pricing_context: p.context,
      reference_type: 'video_generation', reference_id: p.row.drama_id, drama_id: p.row.drama_id,
      source_kind: 'video_draft_final', source_id: p.row.id,
    });
    const at = new Date().toISOString();
    const task = require('./taskService').createTask(db, log, 'video_generation', String(p.row.drama_id || ''), actor.id, p.row.tenant_id);
    const newId = Number(db.prepare(`INSERT INTO video_generations
      (drama_id,storyboard_id,owner_user_id,tenant_id,billing_authorization_id,provider,prompt,model,duration,aspect_ratio,resolution,watermark,ai_config_id,status,task_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'1080p',?,?,'processing',?,?,?)`).run(p.row.drama_id, p.row.storyboard_id, actor.id, p.row.tenant_id,
      auth.authorization_id, p.row.provider, p.row.prompt, p.row.model, p.row.duration, p.row.aspect_ratio, p.row.watermark,
      p.config.id, task.id, at, at).lastInsertRowid);
    const job = db.prepare('SELECT * FROM omni_video_jobs WHERE video_generation_id=? ORDER BY id DESC LIMIT 1').get(p.row.id);
    const snapshot = { ...parse(job?.request_snapshot_json), assets: [], draft_source_generation_id: p.row.id, resolution: '1080p', upscale_resolution: null, target_fps: null };
    db.prepare(`INSERT INTO omni_video_jobs (video_generation_id,owner_user_id,prompt,model_requested,model_resolved,request_snapshot_json,sequence_id,shot_id,storyboard_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(newId, actor.id, p.row.prompt, p.row.model, p.row.model, JSON.stringify(snapshot), job?.sequence_id || null, job?.shot_id || null, p.row.storyboard_id, at, at);
    db.prepare(`INSERT INTO video_draft_tasks (generation_id,stage,source_generation_id,request_key,config_id,config_fingerprint,has_video_input,has_audio_input,created_at)
      VALUES (?,'final',?,?,?,?,?,?,?)`).run(newId, p.row.id, `final:${randomUUID()}`, p.config.id, p.meta.config_fingerprint, p.meta.has_video_input, p.meta.has_audio_input, at);
    if (p.row.storyboard_id) db.prepare("UPDATE storyboards SET active_video_generation_id=?,status='processing',error_msg=NULL,updated_at=? WHERE id=? AND deleted_at IS NULL").run(newId, at, p.row.storyboard_id);
    if (job?.shot_id) db.prepare('UPDATE omni_video_sequence_shots SET omni_job_id=(SELECT id FROM omni_video_jobs WHERE video_generation_id=?),updated_at=? WHERE id=?').run(newId, at, job.shot_id);
    setImmediate(() => require('./videoService').processVideoGeneration(db, log, newId));
    return result(db, newId, actor);
  }).immediate();
}
function list(db, query, actor) {
  let sql = `SELECT v.id FROM video_generations v JOIN video_draft_tasks d ON d.generation_id=v.id
    JOIN omni_video_jobs j ON j.video_generation_id=v.id WHERE d.stage='draft' AND v.owner_user_id=? AND v.deleted_at IS NULL`;
  const args = [actor.id];
  for (const [key, alias] of [['storyboard_id', 'v'], ['shot_id', 'j']]) if (Number(query[key]) > 0) { sql += ` AND ${alias}.${key}=?`; args.push(Number(query[key])); }
  return db.prepare(sql + ' ORDER BY v.id DESC LIMIT 50').all(...args).map(r => result(db, r.id, actor));
}
function recover(db, log, id, actor) {
  const row = db.prepare('SELECT * FROM video_generations WHERE id=? AND deleted_at IS NULL').get(Number(id));
  if (!row || Number(row.owner_user_id) !== Number(actor.id) || !record(db, id)) throw new Error('样片流程任务不存在或无权访问');
  if (!row.provider_task_id) throw new Error('没有可恢复的供应商任务，请先核对原始提交结果');
  if (row.status === 'completed' && localFile(row)) return result(db, id, actor);
  if (!['completed', 'failed', 'processing'].includes(row.status)) throw new Error('当前任务状态不能恢复归档');
  db.prepare("UPDATE video_generations SET status='processing',error_msg=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  setImmediate(() => require('./videoService').resumePollForVideoGeneration(db, log, row.id));
  return result(db, row.id, actor);
}
function resolveArchiveReconciliation(db, row) {
  if (!row.billing_authorization_id || !record(db, row.id)) return;
  const usage = db.prepare('SELECT id FROM billing_usage_logs WHERE authorization_id=? LIMIT 1').get(row.billing_authorization_id);
  if (!usage) return;
  db.prepare(`UPDATE billing_reconciliation_cases SET status='resolved',resolved_at=?,resolved_by=NULL,resolution_json=?
    WHERE authorization_id=? AND status='pending' AND reason LIKE '供应商已完成但媒体归档失败%'`)
    .run(new Date().toISOString(), JSON.stringify({ automatic: true, reason: '媒体归档恢复，已按真实用量完成原预授权结算', usage_log_id: usage.id }), row.billing_authorization_id);
}
function providerFinalBody(db, id, model, watermark) {
  const meta = record(db, id);
  if (meta?.stage !== 'final') return null;
  const source = db.prepare('SELECT provider_task_id FROM video_generations WHERE id=?').get(meta.source_generation_id);
  if (!source?.provider_task_id) throw new Error('原样片供应商任务缺失');
  return { model, content: [{ type: 'draft_task', draft_task: { id: source.provider_task_id } }], resolution: '1080p', watermark: !!watermark };
}
module.exports = { MODEL, installed, record, isDraft, normalPredicate, expiry, capture, summary, create, quote, quoteFinal, finalize, list, recover, resolveArchiveReconciliation, providerFinalBody, assertConfig, assertPinnedConfig };
