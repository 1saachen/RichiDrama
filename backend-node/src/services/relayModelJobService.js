'use strict';
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ai = require('./aiConfigService');
const billing = require('./billingService');
const relay = require('./richbestProvider');
const policy = require('./relayModelPolicy');
const contract = require('./relayModelContract');
const cost = require('./costTransport');
const tasks = require('./taskService');
const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const active = new WeakMap();
function stable(value) { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value; }
function fingerprint(c) { return hash(JSON.stringify([c.id,c.provider,relay.originOf(c.base_url),c.api_key])); }
function row(db,id) { return db.prepare('SELECT * FROM relay_model_jobs WHERE id=?').get(id); }
function set(db,id,values) { const all={...values,updated_at:stamp()}; db.prepare(`UPDATE relay_model_jobs SET ${Object.keys(all).map(key=>`${key}=?`).join(',')} WHERE id=?`).run(...Object.values(all),id); }
function publicJob(db,j) {
  if (!j) return null;
  const transaction=db.prepare("SELECT amount_micro FROM billing_transactions WHERE authorization_id=? AND type='settlement'").get(j.authorization_id);
  const closed=db.prepare("SELECT type FROM billing_transactions WHERE authorization_id=? AND type IN ('settlement','void') LIMIT 1").get(j.authorization_id);
  const message=j.billing_state==='pending_reconciliation'&&j.state==='completed'?'结果已保存，费用待核对，请勿重复生成。':j.error_msg?require('../response').clientMessage(j.error_msg,'生成结果待核对，请联系管理员'):null;
  return {id:j.id,model:j.model,family:j.family,drama_id:j.drama_id,state:j.state,status:j.state,billing_state:closed?.type==='settlement'?'settled':closed?.type==='void'?'released':j.billing_state,error_msg:message,images:JSON.parse(j.files_json),text:j.output_text||'',created_at:j.created_at,updated_at:j.updated_at,completed_at:j.completed_at,charged:transaction ? Math.abs(transaction.amount_micro) / 10000 : null};
}
function visible(db,user,j) {
  if(!j||j.owner_user_id!==user.id)return false;
  const project=db.prepare('SELECT deleted_at FROM dramas WHERE id=?').get(j.drama_id);
  return !project||!!project.deleted_at||!!require('./projectAccessService').access(db,j.drama_id,user.id);
}
function get(db,user,id) { const j=row(db,id); return visible(db,user,j) ? publicJob(db,j) : null; }
function list(db,user) { return db.prepare('SELECT * FROM relay_model_jobs WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 40').all(user.id).filter(j=>visible(db,user,j)).map(j=>publicJob(db,j)); }
function localConfigs(db,user) {
  const tenant=require('./tenantService').tenantForUser(db,user.id);
  const options=tenant ? {tenant_id:tenant.id,user_id:user.id} : {user_id:user.id};
  const configs=['image','text'].flatMap(type=>ai.listConfigs(db,type,options)).filter(c=>c.is_active && relay.isRichbest(c));
  return require('./modelCatalogService').filterConfigs(db,configs,user.id);
}
async function models(db,user) {
  const result=[];
  for (const config of localConfigs(db,user)) {
    if (!config.model.some(model=>policy.family(model))) continue;
    const remote=await relay.listModels({config});
    for (const item of remote.models) if (config.model.includes(item.id) && policy.family(item.id)) result.push({model:item.id,config_id:config.id,family:policy.family(item.id),capabilities:item.capabilities});
  }
  return result;
}
async function prepare(db,user,input) {
  const dramaId=Number(input.drama_id);
  if (!Number.isSafeInteger(dramaId) || !require('./projectAccessService').access(db,dramaId,user.id)?.can_edit) throw Error('请选择有编辑权限的计费归属项目');
  const config=localConfigs(db,user).find(c=>(!input.config_id || Number(input.config_id)===c.id) && c.model.includes(input.model));
  if (!config) throw Error('模型尚未上架、未授权或没有完整价格，请先配置模型目录');
  const catalog=await relay.listModels({config});
  const model=catalog.models.find(item=>item.id===input.model);
  if (!model) throw Error('当前中转业务 Key 未开通此模型');
  if (policy.family(input.model)==='vega_vl' ? model.capabilities.chat!==true : model.capabilities.generations!==true) throw Error('当前项目未开放此模型所需的生成能力');
  const prepared=await contract.prepare(input,model.capabilities);
  const target=ai.resolveBillingTarget(db,config.service_type,input.model,config.id,config.owner_tenant_id ? {tenant_id:config.owner_tenant_id} : {});
  const priced=billing.quote(db,user,{service_type:config.service_type,model:target.billing_key,provider_model:input.model,provider:'richbest',usage:prepared.reservation});
  const remotePrices=(await relay.listPrices({config},input.model)).payload?.data;
  const entry=Array.isArray(remotePrices)?remotePrices.find(item=>item.id===input.model):null;
  if(!entry||entry.configured===false)throw Error('中转站未返回当前模型的可用价目');
  const currentRules=require('./richbestPricingService').buildCandidates([entry],{resolveTarget:()=>({configuredTypes:[config.service_type],billing_key:target.billing_key})}).flat();
  for(const rate of priced.rates) {
    const rule=currentRules.find(item=>item.meter===rate.meter&&item.mapping_status==='mapped');
    if(!rule)throw Error('供应商计费规则已变化或缺失，请重新同步并发布价格');
    const next=JSON.parse(rule.new_conditions_json);
    if(['relay_model_kind','provider_site','free_units','unit_size'].some(key=>(rate.conditions[key]??null)!==(next[key]??null)))throw Error('当前中转渠道与已发布计费口径不一致，请重新同步价格');
  }
  const expected=prepared.type==='gpt_image' ? model.capabilities.imageTokenBilling ? 'gpt_image_tokens' : 'gpt_image_count' : prepared.type;
  if (priced.rates.some(rate=>!policy.enabled(rate.conditions) || rate.conditions.relay_model_kind!==expected)) throw Error('请先重新同步并发布该模型的中转计费规则，不能沿用旧价目');
  policy.validateItems(priced.rates.map(rate=>({service_type:config.service_type,model:target.billing_key,meter:rate.meter,conditions_json:rate.conditions})));
  const sites=[...new Set(priced.rates.map(rate=>rate.conditions.provider_site).filter(Boolean))];
  if (sites.length > 1) throw Error('同一模型的输入输出价格站点不一致');
  return {...prepared,config,target,dramaId,priced};
}
function quoteHash(p) {return hash(JSON.stringify(stable({payload:p.payload,config:fingerprint(p.config),drama:p.dramaId,amount:p.priced.amount_micro,rates:p.priced.rates})));}
async function quote(db,user,input) { const p=await prepare(db,user,input); return {amount:p.priced.amount,model:p.model,n:p.payload.n||1,reservation_only:true,quote_hash:quoteHash(p)}; }
function requestHash(input) { const {idempotency_key,expected_quote,...body}=input; return hash(JSON.stringify(stable(body))); }
async function create(db,log,cfg,user,input) {
  const key=String(input.idempotency_key||'');
  if (!/^[\w:.-]{1,128}$/.test(key)) throw Error('缺少有效的稳定业务请求 ID');
  const digest=requestHash(input);
  const prior=db.prepare('SELECT * FROM relay_model_jobs WHERE owner_user_id=? AND request_key=?').get(user.id,key);
  if (prior) { if(!visible(db,user,prior))throw Error('无权访问此记录');if(prior.request_hash!==digest) throw Error('同一业务请求 ID 已用于不同参数'); return publicJob(db,prior); }
  const p=await prepare(db,user,input);
  if(input.expected_quote!==quoteHash(p))throw Error('请先确认当前报价；价格或设置已变化时须重新确认');
  const id=db.transaction(()=>{
    const again=db.prepare('SELECT * FROM relay_model_jobs WHERE owner_user_id=? AND request_key=?').get(user.id,key);
    if(again) { if(again.request_hash!==digest) throw Error('业务请求 ID 冲突'); return again.id; }
    const jobId=randomUUID(), at=stamp();
    const auth=billing.createAuthorization(db,user,{idempotency_key:`relay-model:${jobId}`,service_type:p.config.service_type,model:p.target.billing_key,provider_model:p.model,provider:'richbest',usage:p.reservation,reference_type:'relay_model_job',reference_id:jobId,drama_id:p.dramaId,source_kind:'relay_model_job',source_id:jobId});
    const ids=[];
    if(p.type!=='vega_vl') for(let i=0;i<p.payload.n;i++) {
      const task=tasks.createTaskFromContext(db,log,'image_generation',String(p.dramaId),user.id,p.config.owner_tenant_id);
      const result=db.prepare(`INSERT INTO image_generations(drama_id,owner_user_id,tenant_id,billing_authorization_id,provider,prompt,model,status,task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(p.dramaId,user.id,p.config.owner_tenant_id||null,i===0?auth.authorization_id:null,'richbest',p.payload.prompt,p.model,task.id,at,at);
      ids.push(Number(result.lastInsertRowid));
    }
    db.prepare(`INSERT INTO relay_model_jobs(id,owner_user_id,tenant_id,drama_id,config_id,credential_fingerprint,model,family,request_key,request_hash,request_json,authorization_id,image_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId,user.id,p.config.owner_tenant_id||null,p.dramaId,p.config.id,fingerprint(p.config),p.model,p.type,key,digest,JSON.stringify(p.payload),auth.authorization_id,JSON.stringify(ids),at,at);
    return jobId;
  })();
  enqueue(db,log,cfg,id);
  return publicJob(db,row(db,id));
}
function pending(db,j,reason,requestId) {
  billing.markPendingReconciliation(db,{id:j.owner_user_id},j.authorization_id,{provider_request_id:requestId||j.provider_request_id,reason});
  set(db,j.id,{state:'reconciliation',billing_state:'pending_reconciliation',error_msg:reason,attempt_count:j.attempt_count+1,next_poll_at:new Date(Date.now()+Math.min(300_000,30_000*2**j.attempt_count)).toISOString()});
}
function fail(db,j,message) {
  billing.voidAuthorization(db,{id:j.owner_user_id},j.authorization_id,message);
  set(db,j.id,{state:'failed',billing_state:'released',error_msg:message,completed_at:stamp()});
  for(const id of JSON.parse(j.image_ids_json)) { db.prepare("UPDATE image_generations SET status='failed',error_msg=?,updated_at=? WHERE id=? AND status<>'completed'").run(message,stamp(),id); const image=db.prepare('SELECT task_id FROM image_generations WHERE id=?').get(id); if(image?.task_id) tasks.updateTaskError(db,image.task_id,message); }
}
async function transport(config,payload,pathname,method='POST') {
  const res=await cost.fetchSubmission(relay.urlFor(config,pathname),{method,headers:relay.headersFor(config,{idempotencyKey:payload.key}),...(method==='POST'?{body:JSON.stringify(payload.body)}:{}),signal:AbortSignal.timeout(method==='GET'?30_000:180_000)});
  let body; try { body=await res.json(); } catch(_) { throw Object.assign(Error('中转响应不是有效 JSON，结果待核对'),{ambiguous:true}); }
  const headers=Object.fromEntries(res.headers);
  if(!res.ok) throw relay.errorFrom(res.status,body,headers);
  return {body,headers,requestId:relay.requestIdFrom(body,headers),...(body.object==='image_task'?{task_id:body.id}:{}),usage:body.usage};
}
async function archive(db,j,payload,cfg) {
  const images=payload?.data;
  const request=JSON.parse(j.request_json);
  if(!Array.isArray(images)||!images.length||images.length>request.n) throw Error('供应商成功结果的图片数量无效');
  const root=path.resolve(cfg.storage?.local_path||'./data/storage'); fs.mkdirSync(root,{recursive:true});
  const subdir=require('./storageLayout').getProjectStorageSubdir(db,j.drama_id);
  const directory=path.join(root,'images',subdir||'');fs.mkdirSync(directory,{recursive:true});
  const relativeDirectory=path.relative(fs.realpathSync(root),fs.realpathSync(directory));
  if(relativeDirectory.startsWith('..')||path.isAbsolute(relativeDirectory))throw Error('图片归档目录超出存储范围');
  const files=JSON.parse(j.files_json);
  for(let i=0;i<images.length;i++) {
    if(files[i]) { require('../utils/storagePath').resolveStorageFile(root,files[i].local_path); continue; }
    const image=images[i]; let bytes;
    if(typeof image.b64_json==='string') { if(image.b64_json.length>56_000_000) throw Error('图片结果过大'); bytes=Buffer.from(image.b64_json,'base64'); }
    else {
      const url=new URL(image.url); if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw Error('图片结果地址无效');
      const response=await fetch(url,{signal:AbortSignal.timeout(30_000)}); if(!response.ok) throw Error('图片下载失败');
      const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>40*1024*1024)throw Error('图片结果过大');chunks.push(chunk);}bytes=Buffer.concat(chunks);
    }
    const sharp=require('sharp'); const meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
    if(!['png','jpeg','webp'].includes(meta.format)||!meta.width||!meta.height) throw Error('供应商结果不是受支持的图片');
    await sharp(bytes,{limitInputPixels:40_000_000}).stats();
    const file=path.join(directory,`relay-${j.id}-${i}.${meta.format==='jpeg'?'jpg':meta.format}`);
    fs.writeFileSync(file,bytes,{flag:'w'});
    const key=path.relative(root,file).replace(/\\/g,'/');require('../utils/storagePath').resolveStorageFile(root,key);
    files.push({image_url:`/static/${key}`,local_path:key,width:meta.width,height:meta.height});
    set(db,j.id,{files_json:JSON.stringify(files)});
  }
  return files;
}
async function complete(db,j,cfg,log) {
  const payload=JSON.parse(j.response_json), request=JSON.parse(j.request_json);
  let files=[], text='';
  if(j.family==='vega_vl') { text=payload?.choices?.[0]?.message?.content; if(typeof text!=='string'||!text.trim()) throw Error('供应商未返回可保存的理解结果'); }
  else files=await archive(db,j,payload,cfg);
  const auth=billing.getAuthorization(db,j.authorization_id);
  const kind=policy.kind(auth?.snapshot);
  const usage=kind==='gpt_image_count'?{image:files.length}:policy.usage(j.model,payload,request);
  try {
    require('./costLedgerService').forAuthorization(db,j.authorization_id,{status:'completed',usage:usage||(files.length?{image:files.length}:null),provider_request_id:j.provider_request_id,provider_task_id:j.provider_task_id});
  } catch(e) {log?.warn?.('relay supplier usage record deferred',{job_id:j.id,error:e.message});}
  let billingState='settled', error=null;
  try {
    if(!usage) throw Error('供应商未返回完整、可核验的真实用量');
    billing.settleAuthorization(db,{id:j.owner_user_id},j.authorization_id,{usage,provider_request_id:j.provider_request_id||j.provider_task_id});
    db.prepare("UPDATE billing_reconciliation_cases SET status='resolved',resolved_at=?,resolution_json=? WHERE authorization_id=? AND status='pending'").run(stamp(),JSON.stringify({source:'relay_model_recovery'}),j.authorization_id);
  } catch(e) {
    billingState='pending_reconciliation';error='结果已保存，费用待核对，请勿重复生成。';
    log?.warn?.('relay settlement deferred',{job_id:j.id,error:e.message});
    billing.markPendingReconciliation(db,{id:j.owner_user_id},j.authorization_id,{reason:`中转结果已保存，结算待核对：${e.message}`,provider_request_id:j.provider_request_id,observed_usage:usage||undefined});
  }
  db.transaction(()=>{
    const ids=JSON.parse(j.image_ids_json);
    for(const [index,id] of ids.entries()) {
      const image=db.prepare('SELECT * FROM image_generations WHERE id=?').get(id);
      if(files[index]) {const f=files[index];db.prepare("UPDATE image_generations SET status='completed',image_url=?,local_path=?,completed_at=?,updated_at=? WHERE id=?").run(f.image_url,f.local_path,stamp(),stamp(),id);tasks.updateTaskResult(db,image.task_id,{image_generation_id:id,...f,status:'completed'});}
      else {db.prepare("UPDATE image_generations SET status='failed',error_msg=?,updated_at=? WHERE id=?").run('供应商实际返回图片少于请求张数，按实际结果结算',stamp(),id);tasks.updateTaskError(db,image.task_id,'供应商未返回此张图片');}
    }
    set(db,j.id,{state:'completed',files_json:JSON.stringify(files),output_text:text,billing_state:billingState,error_msg:error,completed_at:stamp()});
  })();
  // Only these newly generated, locally validated image records are added.
  // Library registration is idempotent and cannot invalidate a completed job.
  for(const id of JSON.parse(j.image_ids_json).slice(0,files.length)) {
    try {
      if(!db.prepare('SELECT id FROM assets WHERE image_gen_id=? AND owner_user_id=? AND deleted_at IS NULL').get(id,j.owner_user_id))require('./assetService').importFromImage(db,{info(){},warn(){},error(){}},id,j.owner_user_id);
    } catch (e) {log?.warn?.('relay image library registration deferred',{job_id:j.id,image_id:id,error:e.message});}
  }
}
async function processJob(db,log,cfg,id) {
  let j=row(db,id); if(!j||['completed','failed'].includes(j.state)) return;
  const released=db.prepare("SELECT 1 FROM billing_transactions WHERE authorization_id=? AND type='void'").get(j.authorization_id);
  if(released) {set(db,id,{state:'failed',billing_state:'released',error_msg:'预授权已由对账处置释放，任务停止，不重新提交',completed_at:stamp()});return;}
  if(j.response_json) { try { await complete(db,j,cfg,log); } catch(e) {pending(db,j,`供应商结果待归档恢复：${e.message}`);} return; }
  const config=ai.getConfig(db,j.config_id);
  if(!config||fingerprint(config)!==j.credential_fingerprint) return pending(db,j,'任务创建时的中转连接或业务 Key 已变化，保留原任务待核对');
  if(j.state==='reconciliation'&&!j.provider_task_id) return;
  if(j.state==='submitting'&&j.family!=='vega_image') return pending(db,j,'进程在供应商提交期间中断，结果未知；不会自动重复生成');
  if(Date.now()>(j.deadline_at?Date.parse(j.deadline_at):Date.parse(j.created_at)+30*60*1000) && j.provider_task_id) {pending(db,j,'等待供应商结果超过 30 分钟，可手动刷新原任务，不能重复生成');set(db,id,{attempt_count:3});return;}
  try {
    const request=JSON.parse(j.request_json);
    let response;
    if(j.provider_task_id) {
      response=await transport(config,{key:`rd-relay-${j.id}`},`/v1/images/tasks/${encodeURIComponent(j.provider_task_id)}`,'GET');
    } else {
      if(j.state==='queued'&&!require('./projectAccessService').access(db,j.drama_id,j.owner_user_id)?.can_edit)return fail(db,j,'项目已删除或编辑权限已撤销，未向供应商提交');
      set(db,j.id,{state:'submitting'});
      response=await cost.run(db,{config,model:j.model,service_type:j.family==='vega_vl'?'text':'image',authorization_id:j.authorization_id,user_id:j.owner_user_id,drama_id:j.drama_id,source_kind:'relay_model_job',source_id:j.id},()=>transport(config,{key:`rd-relay-${j.id}`,body:request},j.family==='vega_image'?'/v1/images/tasks':j.family==='vega_vl'?'/v1/chat/completions':'/v1/images/generations'));
    }
    const body=response.body;
    if(j.family==='vega_image') {
      const taskId=j.provider_task_id||String(body.id||'');
      if(!taskId) throw Object.assign(Error('中转未返回图片任务 ID'),{ambiguous:true});
      set(db,j.id,{provider_task_id:taskId,provider_request_id:response.requestId||j.provider_request_id,state:'running'});
      j=row(db,id);
      if(body.status==='failed') return fail(db,j,String(body.error?.message||'Vega 图片任务失败'));
      if(body.status!=='succeeded') return;
      if(!body.result) throw Object.assign(Error('成功任务缺少结果'),{ambiguous:true});
      set(db,j.id,{response_json:JSON.stringify(body.result),state:'archiving'});
    } else set(db,j.id,{response_json:JSON.stringify(body),provider_request_id:response.requestId,state:'archiving'});
    j=row(db,id);
    await complete(db,j,cfg,log);
  } catch(e) {
    j=row(db,id);
    if(j.response_json||j.provider_task_id||e.ambiguous||!e.status||e.status>=500) pending(db,j,`生成结果待核对：${e.message}`,e.requestId);
    else fail(db,j,e.message);
    log.warn('relay model job deferred or failed',{job_id:id,state:row(db,id).state});
  }
}
function enqueue(db,log,cfg,id) {
  let running=active.get(db); if(!running){running=new Set();active.set(db,running);}if(running.has(id))return;
  running.add(id);setImmediate(()=>processJob(db,log,cfg,id).catch(e=>log.error('relay job recovery failed',{job_id:id,error:e.message})).finally(()=>running.delete(id)));
}
function startRecovery(db,log,cfg,options={}) {
  const sweep=()=>{
    for(const j of db.prepare("SELECT id FROM relay_model_jobs WHERE state IN ('queued','submitting','running','archiving') OR (state='reconciliation' AND attempt_count<3 AND (next_poll_at IS NULL OR next_poll_at<=?) AND (provider_task_id IS NOT NULL OR response_json IS NOT NULL)) ORDER BY updated_at LIMIT 30").all(stamp()))enqueue(db,log,cfg,j.id);
  };
  sweep();const timer=setInterval(sweep,options.pollMs||5000);timer.unref();return async()=>{clearInterval(timer);for(let i=0;i<200&&active.get(db)?.size;i++)await new Promise(resolve=>setTimeout(resolve,5));};
}
function refresh(db,log,cfg,user,id) {
  const j=row(db,id);if(!visible(db,user,j))throw Error('记录不存在');
  if(!['completed','failed'].includes(j.state)&&(j.provider_task_id||j.response_json)) {set(db,id,{attempt_count:0,next_poll_at:null,deadline_at:new Date(Date.now()+30*60*1000).toISOString()});enqueue(db,log,cfg,id);}
  return publicJob(db,row(db,id));
}
module.exports={models,quote,create,list,get,refresh,startRecovery,processJob};
