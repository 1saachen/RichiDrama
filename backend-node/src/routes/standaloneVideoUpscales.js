const response = require('../response');
const jobs = require('../services/standaloneVideoUpscaleService');
const { resolveStoragePath } = require('../services/mediaAssetService');
const { resolveStorageFile } = require('../utils/storagePath');
const { createMediaUpload } = require('./upload');
const uploadTempBackstop = require('../middleware/uploadTempBackstop');

module.exports = (router, cfg, db) => {
  const endpoint = '/video-upscales';
  const upload = createMediaUpload(cfg, 30).single('file');
  const withJob = (handler) => (req, res, next) => {
    const job = jobs.owned(db, req.auth, req.params.id);
    if (!job) return response.notFound(res, '视频超分记录不存在');
    return handler(req, res, job, next);
  };

  router.get(endpoint, (req, res) => response.success(res, jobs.list(db, req.auth, typeof req.query.before === 'string' ? req.query.before : null)));
  router.post(endpoint, upload, uploadTempBackstop, async (req, res) => {
    try { response.created(res, await jobs.importVideo(db, cfg, req.auth, req.file, req.body?.name)); }
    catch (error) { response.badRequest(res, error.message); }
  });
  router.get(`${endpoint}/:id`, withJob((_req, res, job) => response.success(res, jobs.publicJob(job))));
  router.post(`${endpoint}/:id/quote`, withJob((req, res, job) => {
    try { response.success(res, jobs.quote(db, req.auth, job, req.body?.target_resolution)); }
    catch (error) { response.badRequest(res, error.message); }
  }));
  router.post(`${endpoint}/:id/submit`, withJob((req, res, job) => {
    try { response.success(res, jobs.submit(db, cfg, req.auth, job, req.body || {})); }
    catch (error) { response.badRequest(res, error.message); }
  }));
  router.get(`${endpoint}/:id/media/:kind`, withJob((req, res, job, next) => {
    const kind = req.params.kind;
    const relative = kind === 'source' ? job.source_path : (kind === 'result' && job.status === 'completed' ? job.output_path : null);
    let absolute;
    try { absolute = relative && resolveStorageFile(resolveStoragePath(cfg), relative); }
    catch (_) {}
    if (!absolute) return response.notFound(res, '视频文件不可用');
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (kind === 'result' && req.query.download === '1') res.attachment(`超分-${job.target_resolution}.mp4`);
    res.sendFile(absolute, (error) => { if (error) next(error); });
  }));
};
