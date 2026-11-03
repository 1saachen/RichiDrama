'use strict';

const VERSION = 1;
const GPT = /^gpt-image-(?:2|2\.5-(?:flare|sunburst))$/;
const IMAGE = /^vega-image-1\.0-(?:lite|flash|pro)$/;
const VL = /^wand-vega-vl-1\.0-(?:lite|flash|pro)$/;
function family(model) { return GPT.test(model) ? 'gpt_image' : IMAGE.test(model) ? 'vega_image' : VL.test(model) ? 'vega_vl' : null; }
function enabled(c) { return c?.relay_model_billing_version === VERSION; }
function kind(snapshot) { return (snapshot?.rates || []).find(r => enabled(r.conditions))?.conditions.relay_model_kind || null; }
function quantity(c, n) { return Math.max(0, n - (enabled(c) ? Number(c.free_units || 0) : 0)); }
function count(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null; }
function usage(model, payload, request) {
  const type = family(model);
  if (type === 'vega_image') {
    const items = payload?.data;
    if (!Array.isArray(items) || !items.length) return null;
    const value = { image: items.length };
    const refs = Array.isArray(request.image) ? request.image.length : request.image ? 1 : 0;
    // Public task results do not expose supplier-confirmed chargeable input count.
    // The accepted request proves only the free allowance; overage stays pending.
    if (model.endsWith('-pro')) {
      const confirmed = count(payload?.usage?.input_image_count);
      if (refs > 3 && confirmed === null) return null;
      value.input_image = confirmed ?? refs;
    }
    return value;
  }
  const raw = payload?.usage;
  if (type === 'vega_vl') {
    const input = count(raw?.prompt_tokens ?? raw?.input_tokens), output = count(raw?.completion_tokens ?? raw?.output_tokens);
    const details = raw?.prompt_tokens_details || raw?.input_tokens_details || {};
    const a = details.cached_tokens, b = details.cache_read_tokens;
    if ([a,b].some(v => v !== undefined && count(v) === null)) return null;
    const cached = Math.max(a ?? 0, b ?? 0);
    if (input === null || output === null || cached > input) return null;
    return { input_token: input - cached, cache_token: cached, output_token: output };
  }
  if (type === 'gpt_image') {
    const d = raw?.input_tokens_details, o = raw?.output_tokens_details;
    const text = count(d?.text_tokens), image = count(d?.image_tokens), output = count(o?.image_tokens), total = count(raw?.input_tokens);
    const cached = count(d?.cached_tokens ?? 0);
    if ([text,image,output,total,cached].includes(null) || text + image !== total || cached > total) return null;
    let ct = 0, ci = 0;
    if (cached) {
      const split = d.cached_tokens_details;
      if (split) { ct = count(split.text_tokens); ci = count(split.image_tokens); }
      else if (!image) ct = cached;
      else if (!text) ci = cached;
      else return null;
      if (ct === null || ci === null || ct + ci !== cached || ct > text || ci > image) return null;
    }
    return { input_token: text - ct, input_image_token: image - ci, cache_token: cached, output_token: output };
  }
  return null;
}
function validateItems(items) {
  for (const item of items) {
    const c = typeof item.conditions_json === 'string' ? JSON.parse(item.conditions_json) : item.conditions_json;
    if (!enabled(c)) continue;
    if (!['gpt_image_tokens','gpt_image_count','vega_image','vega_vl'].includes(c.relay_model_kind)) throw Error('未识别的中转模型计费规则');
    if (c.free_units && !(c.relay_model_kind === 'vega_image' && item.meter === 'input_image' && c.free_units === 3 && c.provider_model === 'vega-image-1.0-pro')) throw Error('中转免费参考图数量与供应商合约不符');
    if (c.relay_model_kind.startsWith('vega') && !['domestic','international'].includes(c.provider_site)) throw Error('Vega 价目缺少计价站点');
    const needed = c.relay_model_kind === 'gpt_image_tokens' ? ['input_token','input_image_token','output_token'] : c.relay_model_kind === 'vega_vl' ? ['input_token','cache_token','output_token'] : c.provider_model === 'vega-image-1.0-pro' ? ['image','input_image'] : ['image'];
    if (needed.some(meter => !items.some(other => other.service_type === item.service_type && other.model === item.model && other.meter === meter))) throw Error('中转模型价格不完整，请同步并成组发布');
    if (c.provider_site && items.some(other => {
      if(other.service_type!==item.service_type||other.model!==item.model)return false;
      const next=typeof other.conditions_json==='string'?JSON.parse(other.conditions_json):other.conditions_json;
      return enabled(next) && next.provider_site!==c.provider_site;
    })) throw Error('同一模型的价格站点不一致');
  }
}
function studioPrice(db,user,service,model,provider) {
  if(provider!=='richbest'||!family(model))return false;
  if(require('./billingService').activeMeters(db,user,service,model,provider).includes('input_image_token'))return true;
  return require('./billingService').quote(db,user,{service_type:service,model,provider,usage:{image:1}}).rates.some(rate=>enabled(rate.conditions));
}
module.exports = { VERSION, family, enabled, kind, quantity, usage, validateItems, studioPrice };
