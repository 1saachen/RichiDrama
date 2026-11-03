const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const express=require('express');
const sharp=require('sharp');

test('new relay models complete authenticated HTTP billing, local archives and durable recovery',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'richi-relay-models-')),cwd=process.cwd();process.chdir(root);
  const cfg={app:{name:'isolated relay models'},server:{},database:{type:'sqlite',path:path.join(root,'test.db')},storage:{type:'local',local_path:path.join(root,'storage')},payments:{enabled:false},image_proxy:{use_for_video:false},vendor_lock:{enabled:false}};
  fs.writeFileSync('config.yaml',JSON.stringify(cfg));
  const log={info(){},warn(){},error(){},debug(){},infow(){},warnw(){},errorw(){}};
  const {getDb,closeDb}=require('../src/db');
  const {runMigrationsAndEnsure}=require('../src/db/migrate');
  const ai=require('../src/services/aiConfigService'),auth=require('../src/services/authService'),billing=require('../src/services/billingService'),pricing=require('../src/services/richbestPricingService'),jobs=require('../src/services/relayModelJobService');
  const models=[...['2','2.5-flare','2.5-sunburst'].map(x=>`gpt-image-${x}`),...['lite','flash','pro'].map(x=>`vega-image-1.0-${x}`),...['lite','flash','pro'].map(x=>`wand-vega-vl-1.0-${x}`)];
  const capabilities=model=>model.startsWith('gpt-')?{generations:true,maxN:10,imageTokenBilling:true,qualityLevels:['auto','low','medium','high']} : model.startsWith('vega-image')?{generations:true,maxN:model.endsWith('-lite')?1:4,maxInputImages:model.endsWith('-lite')?3:6} : {chat:true,textOnly:!model.endsWith('-pro'),imageInput:true,videoInput:true,audioInput:true,fileInput:true,maxVideos:10};
  const priceEntry=model=>({id:model,...(model.startsWith('gpt-')?{provider:'modeltop'}:{}),modality:model.startsWith('wand-')?'text':'image',configured:true,prices:(model.startsWith('gpt-')?[['input_tokens','text',1e6],['input_tokens','image',1e6],['output_tokens','image',1e6],...(model.includes('2.5')?[['cached_input_tokens',null,1e6]]:[])] : model.startsWith('vega-image')?[['image','domestic:output',1],...(model.endsWith('-pro')?[['image','domestic:input:after_three',1]]:[])] : [['input_tokens','domestic',1e6],['cached_input_tokens','domestic',1e6],['output_tokens','domestic',1e6]]).map(([metric,dimension,unit_size])=>({metric,dimension,unit_size,effective_price_yuan:'1.000000'}))});
  const png=await sharp({create:{width:16,height:16,channels:3,background:'#4477aa'}}).png().toBuffer();
  const calls=[],taskMap=new Map();let denyModel=null,finishTasks=true;
  const relay=http.createServer((req,res)=>{
    const chunks=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
      calls.push({method:req.method,url:req.url,body,key:req.headers['idempotency-key'],authorization:req.headers.authorization});
      const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-request-id':`fixture-${calls.length}`});res.end(JSON.stringify(value));};
      if(req.url==='/v1/models')return send({data:models.filter(m=>m!==denyModel).map(id=>({id,modality:id.startsWith('wand-')?'text':'image',capabilities:capabilities(id)}))});
      if(req.url.startsWith('/v1/pricing'))return send({data:models.map(priceEntry)});
      if(req.method==='GET'&&req.url.startsWith('/v1/images/tasks/')){const task=taskMap.get(req.url.split('/').at(-1));if(!task)return send({error:{message:'missing'}},404);return send(finishTasks?{id:task.id,object:'image_task',status:'succeeded',result:{data:Array.from({length:task.body.n},()=>({b64_json:png.toString('base64')}))}}:{id:task.id,status:'running'});}
      const text=body?.prompt||body?.messages?.[0]?.content||'';
      if(typeof text==='string'&&text.includes('[reject]'))return send({error:{code:'model_not_allowed',message:'fixture rejected'}},403);
      if(typeof text==='string'&&text.includes('[unknown]'))return req.socket.destroy();
      if(req.url==='/v1/images/tasks'){const id=`img_fixture_${taskMap.size+1}`;taskMap.set(id,{id,body});return send({id,object:'image_task',status:'queued'});}
      if(req.url==='/v1/chat/completions')return send({choices:[{message:{content:'素材中是一片蓝色背景。'}}],...(typeof text==='string'&&text.includes('[missing]')?{}:{usage:{prompt_tokens:20,completion_tokens:4,prompt_tokens_details:{cached_tokens:6,cache_read_tokens:6}}})});
      if(req.url==='/v1/images/generations')return send({data:Array.from({length:body.n},()=>({b64_json:typeof text==='string'&&text.includes('[badimage]')?'bm90IGFuIGltYWdl':png.toString('base64')})),...(typeof text==='string'&&text.includes('[missing]')?{}:{usage:{input_tokens:10,input_tokens_details:{text_tokens:10,image_tokens:0,cached_tokens:body.model.includes('2.5')?2:0},output_tokens_details:{image_tokens:8}}})});
      send({error:{message:'unexpected route'}},404);
    });
  });
  let db,server,stopRecovery,token,user,admin,base,project,oldBookId,newBookId,oldPriceRows;
  const request=async(method,url,body,bearer=token)=>{const res=await fetch(base+url,{method,headers:{'content-type':'application/json',...(bearer?{'x-lmd-session':bearer}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
  const wait=async(id,state='completed')=>{for(let i=0;i<160;i++){const r=await request('GET',`/relay-generations/${id}`);if(r.body.data?.state===state)return r.body.data;await delay(20);}throw Error(`job ${id} did not reach ${state}: ${JSON.stringify((await request('GET',`/relay-generations/${id}`)).body)}`);};
  const create=async(model,extra={})=>{const body={model,drama_id:project,prompt:'a blue seaside',idempotency_key:`fixture-${crypto.randomUUID()}`,...extra};const quote=await request('POST','/relay-generations/quote',body);return request('POST','/relay-generations',{...body,expected_quote:quote.body.data?.quote_hash});};
  const authId=id=>db.prepare('SELECT authorization_id FROM relay_model_jobs WHERE id=?').get(id).authorization_id;
  try{
    await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));db=getDb(cfg.database);runMigrationsAndEnsure(db);
    admin=auth.createUser(db,{username:'relay-admin',password:'fixture-password',account_kind:'platform_admin'},null);
    user=auth.createUser(db,{username:'relay-user',password:'fixture-password'},admin.id);token=auth.login(db,user.username,'fixture-password').token;
    const origin=`http://127.0.0.1:${relay.address().port}`;
    for(const type of ['image','text']) ai.createConfig(db,log,{service_type:type,provider:'richbest',name:`relay ${type}`,api_protocol:'richbest',base_url:origin,api_key:'fixture-key',model:models.filter(m=>(m.startsWith('wand-')?'text':'image')===type),is_active:true});
    const rows=pricing.buildCandidates(models.map(priceEntry),{resolveTarget:model=>({configuredTypes:[model.startsWith('wand-')?'text':'image'],billing_key:model})}).flat();
    assert.ok(rows.every(r=>r.mapping_status==='mapped'),JSON.stringify(rows));
    db.prepare("UPDATE billing_price_books SET provider='volcengine' WHERE provider IS NULL").run();
    oldBookId=billing.savePriceBook(db,admin.id,{name:'old relay count book',provider:'richbest',status:'draft',items:['image','storyboard_image'].map(service_type=>({service_type,model:'gpt-image-2',meter:'image',unit_price:40}))}).id;
    db.prepare("UPDATE billing_price_books SET system_managed=1,status='published' WHERE id=?").run(oldBookId);oldPriceRows=db.prepare("SELECT * FROM billing_price_book_items WHERE price_book_id=? AND model='gpt-image-2'").all(oldBookId);
    db.prepare("UPDATE ai_model_catalog SET status='active'").run();billing.adjustBalance(db,admin.id,user.id,100000,'fixture balance',{idempotency_key:'fixture-balance'});
    const app=express();app.use(express.json({limit:'20mb'}));app.use('/api/v1',require('../src/routes').setupRouter(cfg,db,log));app.use('/static',express.static(cfg.storage.local_path));server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}/api/v1`;
    project=(await request('POST','/dramas',{title:'Relay integration'})).body.data.id;
    const adminToken=auth.login(db,admin.username,'fixture-password').token;
    const sync=await request('POST','/admin/provider-prices/richbest/sync',{},adminToken);assert.equal(sync.status,200,JSON.stringify(sync.body));
    assert.ok(sync.body.data.candidates.every(item=>item.mapping_status==='mapped'));
    assert.equal((await request('POST',`/admin/provider-price-syncs/${sync.body.data.id}/accept-mapped`,{},adminToken)).status,200);
    const draft=await request('POST',`/admin/provider-price-syncs/${sync.body.data.id}/create-draft`,{},adminToken);assert.equal(draft.status,201,JSON.stringify(draft.body));
    newBookId=draft.body.data.id;assert.equal(draft.body.data.items.some(item=>item.service_type==='image'&&item.model==='gpt-image-2'&&item.meter==='image'),false,'new token draft excludes inherited count rates');assert.deepEqual(db.prepare('SELECT * FROM billing_price_book_items WHERE price_book_id=?').all(oldBookId),oldPriceRows);
    const published=await request('POST',`/admin/price-books/${draft.body.data.id}/publish`,{confirm:true,reason:'isolated relay acceptance',idempotency_key:'fixture-publish-relay'},adminToken);assert.equal(published.status,200,JSON.stringify(published.body));
    stopRecovery=jobs.startRecovery(db,log,cfg,{pollMs:20});
    await t.test('permission-filtered model catalogue and authorization reject unauthenticated or unopened models before charging',async()=>{
      assert.equal((await request('GET','/relay-models',null,null)).status,401);
      assert.equal((await request('GET','/relay-models')).body.data.length,9);
      const before=db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n;denyModel='vega-image-1.0-lite';assert.equal((await create(denyModel)).status,400);denyModel=null;
      assert.equal(db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n,before);
      assert.equal((await create('wand-vega-vl-1.0-pro')).status,400);
    });
    await t.test('GPT multi-output image token usage settles once and all local media remain readable',async()=>{
      const body={model:'gpt-image-2.5-flare',drama_id:project,prompt:'blue',n:2,idempotency_key:'stable-two-images'};
      body.expected_quote=(await request('POST','/relay-generations/quote',body)).body.data.quote_hash;
      const [a,b]=await Promise.all([request('POST','/relay-generations',body),request('POST','/relay-generations',body)]);
      assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(a.body.data.id,b.body.data.id);
      const done=await wait(a.body.data.id);assert.equal(done.images.length,2);assert.equal(done.billing_state,'settled');
      const usage=db.prepare('SELECT usage_json FROM billing_usage_logs WHERE authorization_id=?').get(authId(done.id));assert.deepEqual(JSON.parse(usage.usage_json),{input_token:8,cache_token:2,output_token:8});
      for(const image of done.images){const res=await fetch(base.replace('/api/v1','')+image.image_url);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),png);}
      assert.equal(db.prepare('SELECT COUNT(*) n FROM assets WHERE drama_id=? AND image_gen_id IS NOT NULL').get(project).n,2);
      assert.equal(calls.filter(c=>c.url==='/v1/images/generations'&&c.body.prompt==='blue').length,1);
      assert.equal((await request('POST','/relay-generations',{...body,prompt:'changed'})).status,400);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE authorization_id=? AND type='settlement'").get(authId(done.id)).n,1);
      assert.ok(done.charged>0);
    });
    await t.test('quote confirmation cannot be skipped or reused after price changes',async()=>{
      const body={model:'gpt-image-2',drama_id:project,prompt:'quote test',idempotency_key:'quote-boundary'};
      assert.equal((await request('POST','/relay-generations',body)).status,400);
      const quoted=await request('POST','/relay-generations/quote',body);
      const price=db.prepare("SELECT id,unit_price_micro FROM billing_price_book_items WHERE model='gpt-image-2' AND meter='output_token'").get();
      db.prepare('UPDATE billing_price_book_items SET unit_price_micro=? WHERE id=?').run(price.unit_price_micro+1,price.id);
      assert.equal((await request('POST','/relay-generations',{...body,expected_quote:quoted.body.data.quote_hash})).status,400);
      db.prepare('UPDATE billing_price_book_items SET unit_price_micro=? WHERE id=?').run(price.unit_price_micro,price.id);
      assert.equal(db.prepare('SELECT id FROM relay_model_jobs WHERE request_key=?').get(body.idempotency_key),undefined);
    });
    await t.test('Vega accepted task survives recovery without another POST and counts actual output',async()=>{
      finishTasks=false;const created=await create('vega-image-1.0-flash',{n:2});assert.equal(created.status,200,JSON.stringify(created.body));const id=created.body.data.id;
      await wait(id,'running');await stopRecovery();const taskId=db.prepare('SELECT provider_task_id FROM relay_model_jobs WHERE id=?').get(id).provider_task_id;assert.ok(taskId);
      const before=calls.filter(c=>c.method==='POST'&&c.url==='/v1/images/tasks').length;finishTasks=true;stopRecovery=jobs.startRecovery(db,log,cfg,{pollMs:20});const done=await wait(id);
      assert.equal(done.images.length,2);assert.equal(done.billing_state,'settled');assert.equal(calls.filter(c=>c.method==='POST'&&c.url==='/v1/images/tasks').length,before);
      assert.deepEqual(JSON.parse(db.prepare('SELECT usage_json FROM billing_usage_logs WHERE authorization_id=?').get(authId(id)).usage_json),{image:2});
      const cost=db.prepare('SELECT c.status,r.usage_json FROM cost_calls c JOIN cost_revisions r ON r.id=c.latest_revision_id WHERE c.authorization_id=?').get(authId(id));assert.equal(cost.status,'completed');assert.equal(JSON.parse(cost.usage_json).image,2);
    });
    await t.test('Vega Pro free references and VL media are validated and billed from real evidence',async()=>{
      const media={type:'image',name:'ref.png',url:`data:image/png;base64,${png.toString('base64')}`};
      const created=await create('vega-image-1.0-pro',{media:[media,media]});assert.equal(created.status,200,JSON.stringify(created.body));const image=await wait(created.body.data.id);assert.equal(image.billing_state,'settled');
      assert.deepEqual(JSON.parse(db.prepare('SELECT usage_json FROM billing_usage_logs WHERE authorization_id=?').get(authId(image.id)).usage_json),{image:1,input_image:2});
      const vl=await create('wand-vega-vl-1.0-pro',{media:[media]});assert.equal(vl.status,200,JSON.stringify(vl.body));const done=await wait(vl.body.data.id);assert.match(done.text,/蓝色/);assert.equal(done.billing_state,'settled');
      assert.deepEqual(JSON.parse(db.prepare('SELECT usage_json FROM billing_usage_logs WHERE authorization_id=?').get(authId(done.id)).usage_json),{input_token:14,cache_token:6,output_token:4});
      const four=await create('vega-image-1.0-pro',{media:[media,media,media,media]});assert.equal((await wait(four.body.data.id)).billing_state,'pending_reconciliation');
    });
    await t.test('explicit failure releases while missing usage and unknown submission preserve frozen amount',async()=>{
      const rejected=await create('gpt-image-2',{prompt:'[reject]'});assert.equal((await wait(rejected.body.data.id,'failed')).billing_state,'released');
      const missing=await create('gpt-image-2',{prompt:'[missing]'});const done=await wait(missing.body.data.id);assert.equal(done.images.length,1);assert.equal(done.billing_state,'pending_reconciliation');
      const unknown=await create('gpt-image-2',{prompt:'[unknown]'});const pending=await wait(unknown.body.data.id,'reconciliation');const before=calls.length;await jobs.processJob(db,log,cfg,pending.id);assert.equal(calls.length,before);
      for(const id of [done.id,pending.id]){assert.equal(db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE authorization_id=? AND type IN ('void','settlement')").get(authId(id)).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reconciliation_cases WHERE authorization_id=?').get(authId(id)).n,1);}
      billing.voidImageAuthorization(db,user,authId(pending.id),'generic task failure');assert.equal(db.prepare("SELECT 1 FROM billing_transactions WHERE authorization_id=? AND type='void'").get(authId(pending.id)),undefined);
    });
    await t.test('all nine model aliases are usable through the authenticated project API',async()=>{
      const image={type:'image',name:'reference.png',url:`data:image/png;base64,${png.toString('base64')}`};
      for(const model of models){const created=await create(model,model.startsWith('wand-')?{media:[image]}:{});assert.equal(created.status,200,JSON.stringify(created.body));const completed=await wait(created.body.data.id);assert.equal(completed.billing_state,'settled',model);}
      const alien=auth.createUser(db,{username:'relay-alien',password:'fixture-password'},admin.id),alienToken=auth.login(db,alien.username,'fixture-password').token;
      const owned=(await request('GET','/relay-generations')).body.data[0];assert.equal((await request('GET',`/relay-generations/${owned.id}`,undefined,alienToken)).status,404);
      assert.equal((await request('POST','/relay-generations',{model:'gpt-image-2',drama_id:project,prompt:'forbidden',idempotency_key:'alien'},alienToken)).status,404);
    });
    await t.test('VL video, audio and file parts use validated media and reject forged content before authorization',async()=>{
      const videoFile=path.join(root,'reference.mp4');
      const made=require('node:child_process').spawnSync(require('../src/utils/ffmpegPath').getFfmpegPath(),['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=5:d=0.4','-c:v','libx264','-pix_fmt','yuv420p',videoFile],{windowsHide:true});assert.equal(made.status,0,String(made.stderr));
      const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
      const media=[{type:'video',name:'clip.mp4',url:`data:video/mp4;base64,${fs.readFileSync(videoFile).toString('base64')}`},{type:'audio',name:'sound.wav',url:`data:audio/wav;base64,${wav.toString('base64')}`},{type:'file',name:'script.txt',url:`data:text/plain;base64,${Buffer.from('fixture story text').toString('base64')}`}];
      const created=await create('wand-vega-vl-1.0-pro',{media});assert.equal(created.status,200,JSON.stringify(created.body));assert.equal((await wait(created.body.data.id)).billing_state,'settled');
      const forwarded=calls.filter(call=>call.url==='/v1/chat/completions').at(-1).body.messages[0].content;assert.deepEqual(forwarded.map(part=>part.type),['text','video_url','input_audio','file']);
      const before=db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n;
      assert.equal((await create('wand-vega-vl-1.0-pro',{media:[{type:'audio',name:'broken.wav',url:`data:audio/wav;base64,${Buffer.from('not a wav').toString('base64')}`}]})).status,400);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE type='authorization'").get().n,before);
    });
    await t.test('broken archive remains recoverable and credential change never queries with a replacement key',async()=>{
      const broken=await create('gpt-image-2',{prompt:'[badimage]'});const pending=await wait(broken.body.data.id,'reconciliation');assert.ok(db.prepare('SELECT response_json FROM relay_model_jobs WHERE id=?').get(pending.id).response_json);
      const raw=JSON.parse(db.prepare('SELECT response_json FROM relay_model_jobs WHERE id=?').get(pending.id).response_json);raw.data=[{b64_json:png.toString('base64')}];db.prepare('UPDATE relay_model_jobs SET response_json=? WHERE id=?').run(JSON.stringify(raw),pending.id);await jobs.processJob(db,log,cfg,pending.id);assert.equal((await wait(pending.id)).billing_state,'settled');
      finishTasks=false;const waiting=await create('vega-image-1.0-lite');await wait(waiting.body.data.id,'running');await stopRecovery();const bound=db.prepare('SELECT config_id FROM relay_model_jobs WHERE id=?').get(waiting.body.data.id);db.prepare('UPDATE ai_service_configs SET api_key=? WHERE id=?').run('replacement-key',bound.config_id);const before=calls.length;await jobs.processJob(db,log,cfg,waiting.body.data.id);assert.equal(calls.length,before);assert.equal((await request('GET',`/relay-generations/${waiting.body.data.id}`)).body.data.state,'reconciliation');
    });
    await t.test('migration and database reopening retain completed local results and legacy accounting unchanged',async()=>{
      const newPrices=db.prepare("SELECT * FROM billing_price_book_items WHERE price_book_id=? AND model='gpt-image-2' ORDER BY id").all(newBookId);
      const before=db.prepare('SELECT * FROM billing_usage_logs ORDER BY id').all();runMigrationsAndEnsure(db);assert.deepEqual(db.prepare('SELECT * FROM billing_usage_logs ORDER BY id').all(),before);
      assert.deepEqual(db.prepare("SELECT * FROM billing_price_book_items WHERE price_book_id=? AND model='gpt-image-2' ORDER BY id").all(newBookId),newPrices,'legacy boot seeding cannot add count prices to a new relay token book');assert.deepEqual(db.prepare("SELECT * FROM billing_price_book_items WHERE price_book_id=? AND model='gpt-image-2'").all(oldBookId),oldPriceRows);
      const done=(await request('GET','/relay-generations')).body.data.find(j=>j.state==='completed'&&j.images.length);await new Promise(resolve=>server.close(resolve));server=null;closeDb();db=getDb(cfg.database);runMigrationsAndEnsure(db);assert.deepEqual(db.prepare('SELECT * FROM billing_usage_logs ORDER BY id').all(),before);assert.equal(jobs.get(db,user,done.id).images[0].local_path,done.images[0].local_path);assert.equal(jobs.get(db,{id:user.id+100},done.id),null);
      db.prepare('UPDATE dramas SET deleted_at=? WHERE id=?').run(new Date().toISOString(),project);assert.equal(jobs.get(db,user,done.id).images[0].local_path,done.images[0].local_path,'owner history remains readable after project deletion');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    });
  }finally{if(stopRecovery)await stopRecovery();if(server)await new Promise(resolve=>server.close(resolve));relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve));closeDb();process.chdir(cwd);fs.rmSync(root,{recursive:true,force:true});}
});
