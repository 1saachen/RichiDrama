'use strict';

// Contract evidence: star_proxy/backend/app/vega.py measurements(), reviewed
// with docs/client-api/vega.md. Never substitute requested duration for usage.
function modelProfile(model) {
  if (!/^vega-(?:1\.0-(?:lite|pro|pro-fast|pro-mini)|1\.5-pro)$/.test(String(model))) return null;
  return { lite: model === 'vega-1.0-lite', outputMax: model === 'vega-1.5-pro' ? 30 : 15, inputMax: model === 'vega-1.5-pro' ? 300 : 15 };
}
function policy(snapshot) { return snapshot?.rates?.find(rate => rate.conditions?.relay_video_billing_version === 1)?.conditions || null; }
function reservation(meters, options = {}) {
  const profile = modelProfile(options.model);
  if (!profile || !meters.includes('second')) return null;
  if (profile.lite && !meters.includes('input_image')) throw new Error('Vega Lite 缺少超额参考图价格，请先同步完整供应商价目');
  const duration = Number(options.requested_duration);
  if (duration === -1 && profile.lite) throw new Error('Vega Lite 不支持智能时长');
  if (Number.isFinite(duration) && duration !== -1 && (duration < 4 || duration > profile.outputMax)) throw new Error(`此 Vega 模型时长须在 4–${profile.outputMax} 秒之间`);
  // Use the documented upper bounds for a reservation, never a token estimate.
  const usage = { second: profile.outputMax + (options.has_video_input ? profile.inputMax : 0) };
  if (profile.lite) usage.input_image = 4; // max nine images, first five free
  return usage;
}
function seconds(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || !/^\d+(?:\.\d{1,6})?$/.test(String(value))) return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
function actualUsage(snapshot, raw) {
  if (!policy(snapshot)) return null;
  const profile = modelProfile(snapshot.provider_model || policy(snapshot).provider_model);
  const source = raw?.vega;
  const output = seconds(source?.OutputSeconds); const input = seconds(source?.InputSeconds);
  const hasVideo = snapshot.pricing_context?.has_video_input === true;
  if (!profile || !output || ((hasVideo || profile.lite) && input === null) || (!hasVideo && input > 0)) throw new Error('Vega 缺少或返回了无效的真实输入／输出秒数，保留预授权等待对账');
  const billableInput = hasVideo ? profile.lite ? input : Math.max(input, output * 2 / 3) : 0;
  const usage = { second: Number((output + billableInput).toFixed(12)) };
  if (profile.lite) {
    const images = seconds(source?.InputImageCount);
    if (!Number.isSafeInteger(images)) throw new Error('Vega Lite 未返回真实参考图数量，保留预授权等待对账');
    usage.input_image = Math.max(0, images - 5);
  }
  return usage;
}
module.exports = { modelProfile, policy, reservation, actualUsage };
