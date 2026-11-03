const test=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../src/services/relayModelPolicy');
const pricing=require('../src/services/richbestPricingService');
const contract=require('../src/services/relayModelContract');
const fixture=(model,prices)=>({id:model,modality:model.includes('-vl-')?'text':'image',configured:true,prices:prices.map(([metric,dimension,unit_size=1])=>({metric,dimension,unit_size,effective_price_yuan:'1.250000'}))});
test('captured live ModelTop and Vega image prices map exactly without losing input modality',()=>{
  const entries=require('./helpers/richbestImagePricingLive20261103.json');
  const rows=pricing.buildCandidates(entries,{resolveTarget:model=>({configuredTypes:['image'],billing_key:model})}).flat();
  assert.equal(rows.length,15);assert.ok(rows.every(row=>row.mapping_status==='mapped'),JSON.stringify(rows));
  for(const model of ['gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst']) {
    const rates=rows.filter(row=>row.provider_model===model);
    assert.equal(rates.find(row=>row.meter==='input_token').new_unit_price_micro,33532470);
    assert.equal(rates.find(row=>row.meter==='input_image_token').new_unit_price_micro,53651952);
    assert.equal(rates.find(row=>row.meter==='output_token').new_unit_price_micro,201194820);
    assert.ok(rates.every(row=>JSON.parse(row.new_conditions_json).relay_model_kind==='gpt_image_tokens'));
    if(model.includes('2.5'))assert.equal(rates.find(row=>row.meter==='cache_token').new_unit_price_micro,8383118);
  }
  policy.validateItems(rows.map(row=>({...row,model:row.billing_key,conditions_json:row.new_conditions_json})));
  const unknown=pricing.pricePiece({...entries[0],provider:'unverified'},{metric:'input_tokens',dimension:'image',unit_size:1e6,effective_price_yuan:'1.000000'});
  assert.match(unknown.reason,/未识别/,'raw dimensions require the verified ModelTop provider');
});
test('GPT image text/image/cache prices remain separate and Vega sites map explicitly',()=>{
  const entries=[fixture('gpt-image-2.5-flare',[['input_tokens','modeltop:text',1e6],['input_tokens','modeltop:image',1e6],['output_tokens','modeltop:image',1e6],['cached_input_tokens','modeltop:',1e6]]),fixture('vega-image-1.0-pro',[['image','domestic:output'],['image','domestic:input:after_three']]),fixture('wand-vega-vl-1.0-pro',[['input_tokens','international',1e6],['output_tokens','international',1e6],['cached_input_tokens','international',1e6]])];
  const rows=pricing.buildCandidates(entries,{resolveTarget:model=>({configuredTypes:[model.includes('-vl-')?'text':'image'],billing_key:model})}).flat();
  assert.equal(rows.length,9);assert.ok(rows.every(row=>row.mapping_status==='mapped'),JSON.stringify(rows));
  const image=rows.find(row=>row.meter==='input_image_token');assert.equal(image.new_unit_price_micro,1250000);assert.equal(JSON.parse(image.new_conditions_json).relay_model_kind,'gpt_image_tokens');
  const input=rows.find(row=>row.meter==='input_image');assert.equal(JSON.parse(input.new_conditions_json).free_units,3);
  policy.validateItems(rows.map(row=>({...row,model:row.billing_key,conditions_json:row.new_conditions_json})));
});
test('GPT missing or inconsistent modality usage is never priced as plain text',()=>{
  const raw={input_tokens:12,input_tokens_details:{text_tokens:10,image_tokens:2,cached_tokens:4,cached_tokens_details:{text_tokens:3,image_tokens:1}},output_tokens_details:{image_tokens:8}};
  assert.deepEqual(policy.usage('gpt-image-2',{usage:raw},{}),{input_token:7,input_image_token:1,cache_token:4,output_token:8});
  assert.equal(policy.usage('gpt-image-2',{usage:{input_tokens:12,output_tokens:8}},{}),null);
  assert.equal(policy.usage('gpt-image-2',{usage:{...raw,input_tokens:11}},{}),null);
  assert.equal(policy.usage('gpt-image-2',{usage:{...raw,input_tokens_details:{text_tokens:10,image_tokens:2,cached_tokens:4}}},{}),null);
});
test('VL overlapping cached counters are not added twice and invalid counts stay pending',()=>{
  assert.deepEqual(policy.usage('wand-vega-vl-1.0-lite',{usage:{prompt_tokens:20,completion_tokens:4,prompt_tokens_details:{cached_tokens:6,cache_read_tokens:6}}},{}),{input_token:14,cache_token:6,output_token:4});
  assert.equal(policy.usage('wand-vega-vl-1.0-lite',{usage:{prompt_tokens:20,completion_tokens:4,prompt_tokens_details:{cached_tokens:21}}},{}),null);
});
test('Vega Pro free reference allowance cannot be reused for unconfirmed chargeable inputs',()=>{
  const payload={data:[{url:'https://example.com/image.png'}]};
  assert.deepEqual(policy.usage('vega-image-1.0-pro',payload,{image:['a','b']}),{image:1,input_image:2});
  assert.equal(policy.usage('vega-image-1.0-pro',payload,{image:['a','b','c','d']}),null);
  assert.equal(policy.quantity({relay_model_billing_version:1,free_units:3},5),2);
  assert.equal(policy.quantity({free_units:3},5),5,'legacy rules do not inherit new free allowances');
});
test('model-specific contracts reject unsupported references, fields, and VL Pro text-only before dispatch',async()=>{
  await assert.rejects(contract.prepare({model:'wand-vega-vl-1.0-pro',prompt:'hello'},{}),/至少需要/);
  await assert.rejects(contract.prepare({model:'vega-image-1.0-lite',prompt:'hello',n:2},{maxN:1}),/生成张数/);
  await assert.rejects(contract.prepare({model:'gpt-image-2',prompt:'hello',seed:2},{maxN:1}),/不支持的参数/);
  await assert.rejects(contract.prepare({model:'gpt-image-2',prompt:'hello',quality:'max'},{maxN:1}),/质量/);
  const p=await contract.prepare({model:'vega-image-1.0-pro',prompt:'hello'},{maxN:4,maxInputImages:6});assert.equal(p.reservation.input_image,3);
});
test('incomplete and mixed-site new books are rejected, legacy books remain untouched',()=>{
  assert.throws(()=>policy.validateItems([{service_type:'image',model:'m',meter:'output_token',conditions_json:{relay_model_billing_version:1,relay_model_kind:'gpt_image_tokens'}}]),/不完整/);
  policy.validateItems([{service_type:'image',model:'old',meter:'image',conditions_json:{free_units:7}}]);
});
test('Vega Lite/Flash included reference rows do not become unsupported or chargeable input prices',()=>{
  for(const model of ['vega-image-1.0-lite','vega-image-1.0-flash']) {
    const entry=fixture(model,[['image','domestic:output'],['image','domestic:input:after_three']]);entry.prices[1].effective_price_yuan='0.000000';
    const rows=pricing.buildCandidates([entry],{resolveTarget:()=>({configuredTypes:['image'],billing_key:model})}).flat();
    assert.equal(rows.length,1);assert.equal(rows[0].meter,'image');assert.equal(rows[0].mapping_status,'mapped');
  }
});
