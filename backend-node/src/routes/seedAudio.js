const express = require('express');
const response = require('../response');
const { getActiveProfile } = require('../config');
const jobs = require('../services/seedAudioService');

const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;
const requestErrorCodes = new Map([
  [400, 'BAD_REQUEST'],
  [401, 'UNAUTHORIZED'],
  [402, 'INSUFFICIENT_BALANCE'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [422, 'INVALID_INPUT'],
  [429, 'TOO_MANY_REQUESTS'],
]);

function isLocalRequest(req) {
  const host = req.get('host') || '';
  const match = loopbackHost.exec(host);
  if (!loopbackPeers.has(req.socket.remoteAddress) || !match) return false;
  if (match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65_535)) return false;
  if (Object.keys(req.headers).some((name) => name === 'forwarded' || name === 'x-real-ip' || name === 'via' || name.startsWith('x-forwarded-'))) return false;

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = req.get('origin');
  if (origin === undefined) return true;
  const protocol = req.socket.encrypted ? 'https' : 'http';
  return origin === new URL(`${protocol}://${host}`).origin;
}

function isAvailable(req) {
  if (req.auth?.role !== 'admin' || !req.auth.console_access) return false;
  if (getActiveProfile() === 'dev') return isLocalRequest(req);
  const endpoint = jobs.productionOrigin();
  if (!endpoint || req.get('host')?.toLowerCase() !== endpoint.host) return false;
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && (req.method === 'POST' || fetchSite !== 'none')) return false;
  const origin = req.get('origin');
  return req.method === 'POST' ? origin === endpoint.origin : origin === undefined || origin === endpoint.origin;
}

module.exports = (db, log, cfg) => {
  const router = express.Router();
  const configuration = (actor) => {
    const { configured, max_duration_seconds, rate_credits_per_minute } = jobs.configuration(db, actor);
    return { available: true, configured: Boolean(configured), max_duration_seconds, rate_credits_per_minute };
  };
  const handle = (run) => async (req, res) => {
    try {
      await run(req, res);
    } catch (error) {
      const status = Number(error.status ?? error.statusCode);
      const code = requestErrorCodes.get(status);
      if (code) return response.error(res, status, code, error.message);
      log.warn('Seed Audio request failed', { request_id: req.requestId });
      return response.internalError(res);
    }
  };

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  router.get('/config', handle((req, res) => {
    const value = isAvailable(req) ? configuration(req.auth) : { available: false, configured: false };
    response.success(res, value);
  }));

  router.use((req, res, next) => {
    if (!isAvailable(req)) return response.forbidden(res, '当前环境或账号未开放音频生成');
    if (req.method === 'POST' && !req.is('application/json')) {
      return response.badRequest(res, '请提交 JSON 请求');
    }
    next();
  });
  router.get('/jobs', handle((req, res) => {
    response.success(res, jobs.list(db, req.auth));
  }));
  router.post('/jobs', handle(async (req, res) => {
    response.created(res, await jobs.create(db, log, cfg, req.auth, req.body));
  }));
  return router;
};
