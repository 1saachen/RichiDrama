const response = require('../response');
const service = require('../services/videoDraftService');
module.exports = (db, log) => ({
  list(req, res) { try { response.success(res, service.list(db, req.query || {}, req.auth)); } catch (error) { response.badRequest(res, error.message); } },
  quote(req, res) { try { response.success(res, service.quoteFinal(db, req.params.id, req.auth)); } catch (error) { response.badRequest(res, error.message); } },
  recover(req, res) { try { response.success(res, service.recover(db, log, req.params.id, req.auth)); } catch (error) { response.badRequest(res, error.message); } },
  finalize(req, res) {
    try {
      const fields = Object.keys(req.body || {});
      if (fields.some(key => key !== 'idempotency_key')) return response.badRequest(res, '升级样片不能覆盖原始创作参数');
      response.created(res, service.finalize(db, log, req.params.id, req.auth));
    } catch (error) { response.badRequest(res, error.message); }
  },
});
