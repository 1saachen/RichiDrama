'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { Readable } = require('node:stream');

const HOST = 'openspeech.bytedance.com';
const AUTHORITY = `${HOST}:443`;

function unsubmitted(phase, error) {
  const value = error?.code;
  return Object.assign(new Error('Seed Audio connection was not established'), {
    code: 'SEED_AUDIO_UNSUBMITTED',
    phase,
    diagnosticCode: typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'UNKNOWN',
  });
}

function proxyConfiguration(fallback) {
  const value = String(process.env.SEED_AUDIO_HTTPS_PROXY || '').trim() || String(fallback || '').trim();
  if (!value) return null;
  try {
    const proxy = new URL(value);
    if (proxy.protocol === 'http:' && !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash) return proxy;
  } catch (_) {}
  throw unsubmitted('proxy_config', { code: 'INVALID_PROXY_URL' });
}

function connectProxy(proxy, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || 80,
      method: 'CONNECT', path: AUTHORITY, headers: { Host: AUTHORITY }, agent: false, signal,
    });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject({ code: `HTTP_${response.statusCode}` });
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.once('error', reject);
    request.end();
  });
}

function connectVerified(tunnel, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...(tunnel ? { socket: tunnel } : { host: HOST, port: 443 }),
      servername: HOST,
      rejectUnauthorized: true,
    });
    const abort = () => socket.destroy(Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' }));
    const clear = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('error', (error) => { clear(); reject(error); });
    socket.once('close', () => { clear(); reject({ code: 'ECONNRESET' }); });
    socket.once('secureConnect', () => {
      clear();
      if (!socket.authorized) {
        socket.destroy();
        reject({ code: 'CERTIFICATE_NOT_AUTHORIZED' });
        return;
      }
      resolve(socket);
    });
  });
}

async function send({ apiKey, requestId, prompt, timeoutMs, proxyUrl }) {
  const proxy = proxyConfiguration(proxyUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  let tunnel;
  if (proxy) {
    try { tunnel = await connectProxy(proxy, signal); }
    catch (error) { throw unsubmitted('proxy_connect', error); }
  }
  let socket;
  try { socket = await connectVerified(tunnel, signal); }
  catch (error) {
    tunnel?.destroy();
    throw unsubmitted('destination_tls', error);
  }

  const payload = Buffer.from(JSON.stringify({
    model: 'seed-audio-1.0',
    text_prompt: prompt,
    audio_config: { format: 'mp3' },
  }));
  try {
    return await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: HOST,
        path: '/api/v3/tts/create',
        method: 'POST',
        // Supplying the verified socket bypasses the HTTPS connection pool.
        createConnection: () => socket,
        signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'X-Api-Key': apiKey,
          'X-Api-Request-Id': requestId,
        },
      }, (incoming) => {
        const status = incoming.statusCode;
        try {
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: new Headers(incoming.headers),
            body: Readable.toWeb(incoming, { strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength } }),
          });
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      request.once('error', reject);
      request.end(payload);
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

module.exports = { send };
