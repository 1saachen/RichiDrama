'use strict';
const policy = require('./relayModelPolicy');
const RATIOS = ['1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'];
const MAX_BYTES = 8 * 1024 * 1024;
async function probeMedia(item) {
  if(!['video','audio'].includes(item.type))return;
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'richi-relay-media-')),file=path.join(dir,'input');
  try {
    await fs.writeFile(file,item.bytes,{flag:'wx'});
    const run=require('node:util').promisify(require('node:child_process').execFile);
    const result=await run(require('../utils/ffmpegPath').getFfprobePath(),['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',file],{timeout:10000,maxBuffer:1024*1024,windowsHide:true});
    const info=JSON.parse(result.stdout);
    if(!info.streams?.some(stream=>stream.codec_type===item.type)||!Number.isFinite(Number(info.format?.duration))||Number(info.format.duration)<=0)invalid('素材缺少有效的媒体轨道或时长');
  } catch (_) {invalid('无法验证音视频素材，请检查文件完整性及服务器媒体工具');}
  finally {await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});}
}
function invalid(message) { throw Object.assign(Error(message), { status: 400 }); }
function integer(value, min, max, label) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}须为 ${min}–${max} 的整数`); return value; }
function mediaPart(item) {
  if (!item || !['image','video','audio','file'].includes(item.type)) invalid('素材类型无效');
  const value = String(item.url || '');
  if (value.length > MAX_BYTES * 1.4) invalid('单份素材不能超过 8 MiB');
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!data) invalid('请上传本地素材；此入口不接受未经校验的远程地址');
  const mime = data[1], bytes = Buffer.from(data[2], 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== data[2]) invalid('素材 Base64 无效或过大');
  const allowed = { image:['image/png','image/jpeg','image/webp'], video:['video/mp4','video/quicktime','video/webm'], audio:['audio/mpeg','audio/mp3','audio/wav','audio/x-wav'], file:['application/pdf','text/plain'] };
  if (!allowed[item.type].includes(mime)) invalid('该素材格式暂不支持');
  const signatures={video:()=>mime==='video/webm'?bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):bytes.subarray(4,8).toString()==='ftyp',audio:()=>mime.includes('wav')?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE':bytes.subarray(0,3).toString()==='ID3'||bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0,file:()=>mime==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':!bytes.includes(0)&&!bytes.toString('utf8').includes('\ufffd')};
  if(signatures[item.type]&&!signatures[item.type]())invalid('素材真实格式与声明不一致');
  const part = item.type === 'image' ? { type:'image_url', image_url:{url:value} } : item.type === 'video' ? {type:'video_url',video_url:{url:value}} : item.type === 'audio' ? {type:'input_audio',input_audio:{url:value}} : {type:'file',file:{file_data:value,file_name:String(item.name || 'material').slice(0,120)}};
  return { part, value, bytes, mime, type:item.type };
}
async function prepare(input, capability = {}) {
  const model = String(input.model || ''), type = policy.family(model);
  if (!type) invalid('请选择已适配的中转模型');
  const allowed = new Set(['model','config_id','drama_id','idempotency_key','expected_quote','prompt','media','n','size','aspect_ratio','quality','output_format','watermark','max_tokens','thinking_enabled']);
  if (Object.keys(input).some(key => !allowed.has(key))) invalid('请求包含不支持的参数');
  const prompt = String(input.prompt || '');
  if (prompt.length > (type === 'vega_image' ? 2000 : 16000)) invalid('提示词超过该模型上限');
  const media = (Array.isArray(input.media) ? input.media : []).map(mediaPart);
  if (media.reduce((sum,item)=>sum+item.bytes.length,0) > MAX_BYTES) invalid('素材合计不能超过 8 MiB');
  for (const item of media.filter(item=>item.type==='image')) {
    try { const sharp=require('sharp'); const meta = await sharp(item.bytes, {limitInputPixels:40_000_000}).metadata(); if (!['png','jpeg','webp'].includes(meta.format) || `image/${meta.format}` !== item.mime) invalid('参考图真实格式与声明不一致');await sharp(item.bytes,{limitInputPixels:40_000_000}).stats(); }
    catch (_) { invalid('无法读取参考图片'); }
  }
  for(const item of media)await probeMedia(item);
  if (!prompt.trim() && !media.length) invalid('请填写提示词或上传素材');
  if (type === 'vega_vl') {
    if (model.endsWith('-pro') && !media.length) invalid('Vega-VL Pro 至少需要一份图片、视频、音频或文件');
    for (const item of media) if (capability[`${item.type}Input`] !== true) invalid('当前项目模型未开放该素材输入能力');
    if (media.filter(item=>item.type==='video').length > Math.min(10,capability.maxVideos ?? 10)) invalid('视频素材超过模型数量限制');
    const max = integer(input.max_tokens ?? 2048, 128, 8192, '回答长度');
    if (input.thinking_enabled !== undefined && typeof input.thinking_enabled !== 'boolean') invalid('思考开关须为布尔值');
    return { model, type, payload:{model,messages:[{role:'user',content:media.length ? [{type:'text',text:prompt},...media.map(item=>item.part)] : prompt}],stream:false,max_tokens:max,...(input.thinking_enabled !== undefined ? {thinking_enabled:input.thinking_enabled} : {})}, reservation:{input_token:Buffer.byteLength(prompt)+media.reduce((n,item)=>n+Math.max(item.bytes.length,16384),0),output_token:max} };
  }
  const maxN = Math.min(type === 'vega_image' ? model.endsWith('-lite') ? 1 : 4 : 10, capability.maxN ?? 1);
  const n = integer(input.n ?? 1,1,maxN,'生成张数');
  const payload = {model,prompt,n};
  if (type === 'gpt_image') {
    if (media.length) invalid('当前 GPT Image 渠道只开放文生图');
    payload.size = input.size || '1024x1024';
    const dimensions=['auto','1024x1024','1536x1024','1024x1536','2048x2048','2048x1152','3840x2160','2160x3840'];
    if (!dimensions.includes(payload.size)) invalid('GPT Image 图片尺寸无效');
    payload.quality = input.quality || 'medium';
    if (!(capability.qualityLevels || ['auto','low','medium','high']).includes(payload.quality)) invalid('当前模型不支持该图片质量');
    if (input.output_format && capability.outputFormat !== true) invalid('当前模型未开放输出格式设置');
    if (input.output_format && !['png','jpeg','webp'].includes(input.output_format)) invalid('输出格式无效');
    if (input.output_format) payload.output_format = input.output_format;
    payload.response_format = capability.imageTokenBilling ? 'b64_json' : 'url';
    return {model,type,payload,reservation:capability.imageTokenBilling ? {input_token:Buffer.byteLength(prompt)+1024,input_image_token:16384,output_token:65536*n} : {image:n}};
  }
  if (media.some(item=>item.type !== 'image')) invalid('Vega 生图只接受参考图片');
  if (media.length > Math.min(model.endsWith('-lite') ? 3 : 6,capability.maxInputImages ?? 0)) invalid('参考图片超过当前模型上限');
  if (media.reduce((sum,item)=>sum+item.bytes.length,0) > 7*1024*1024) invalid('Vega 参考图合计不能超过 7 MiB');
  payload.size = input.size || '1K'; payload.aspect_ratio = input.aspect_ratio || '1:1'; payload.response_format = 'url';
  if (!['1K','2K','4K'].includes(payload.size) || !RATIOS.includes(payload.aspect_ratio)) invalid('Vega 图片尺寸或比例无效');
  if (media.length) payload.image = media.map(item=>item.value);
  if (input.watermark !== undefined) { if (typeof input.watermark !== 'boolean') invalid('水印开关须为布尔值'); payload.watermark = input.watermark; }
  return {model,type,payload,reservation:{image:n,...(model.endsWith('-pro') ? {input_image:Math.max(3,media.length)} : {})}};
}
module.exports = { prepare, RATIOS, MAX_BYTES };
