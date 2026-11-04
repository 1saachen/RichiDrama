const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalogFixture } = require('./helpers/modelCatalogFixture');

test('history adoption matches durable standalone and project bindings across HTTP reads and restart', async () => {
  // Isolated SQLite and HTTP routes only. No generation handlers, recovery
  // workers or supplier credentials are used by this regression.
  const f = await modelCatalogFixture();
  try {
    const login = await f.request('POST', '/auth/login', {username:'catalog-admin',password:'fixture-password'});
    const cookie = login.cookie;
    const seq = await f.request('POST', '/omni-video-sequences', {name:'adoption fixture'}, cookie);
    const sequenceId = seq.body.data.id, shotId = seq.body.data.shots[0].id;
    const at = new Date().toISOString();
    const video = f.db.prepare(`INSERT INTO video_generations
      (id,owner_user_id,status,provider,model,duration,local_path,created_at,updated_at)
      VALUES (?,?,'completed','fixture','fixture-video',4,?,?,?)`);
    const job = f.db.prepare(`INSERT INTO omni_video_jobs
      (id,video_generation_id,owner_user_id,sequence_id,shot_id,prompt,model_requested,model_resolved,created_at,updated_at)
      VALUES (?,?,?,?,?,'fixture','fixture-video','fixture-video',?,?)`);
    for (const [generationId, jobId] of [[101,201],[102,202],[103,203]]) {
      video.run(generationId, f.admin.id, `videos/${generationId}.mp4`, at, at);
      job.run(jobId, generationId, f.admin.id, sequenceId, shotId, at, at);
    }
    const bind = id => f.db.prepare('UPDATE omni_video_sequence_shots SET omni_job_id=? WHERE id=?').run(id,shotId);
    const list = async () => {
      const r = await f.request('GET', `/omni-video-jobs?shot_id=${shotId}`, undefined,cookie);
      assert.equal(r.status,200); return r.body.data;
    };
    const detail = async id => {
      const r = await f.request('GET', `/omni-video-jobs/${id}`, undefined,cookie);
      assert.equal(r.status,200);return r.body.data;
    };
    const verify = async current => {
      const items = await list();
      assert.deepEqual(items.filter(x=>x.is_current).map(x=>x.id), current ? [current] : []);
      for(const id of [201,202]) assert.equal((await detail(id)).is_current,id===current,`detail ${id}`);
      assert.ok(items.every(x=>!Object.hasOwn(x,'sequence_current_omni_job_id')),'internal join fields stay private');
    };
    bind(202);
    await verify(202); // Omni job 202 is distinct from video generation 102.
    const meta = f.db.prepare(`INSERT INTO video_draft_tasks
      (generation_id,stage,source_generation_id,request_key,config_id,config_fingerprint,created_at)
      VALUES (?,?,?,?,1,'fixture',?)`);
    meta.run(103,'draft',null,'draft-fixture',at);
    meta.run(102,'final',103,'final-fixture',at);
    assert.ok(!(await list()).some(x=>x.id===203),'the sample is separate from formal history');
    await verify(202);
    const before = JSON.stringify({shots:f.db.prepare('SELECT * FROM omni_video_sequence_shots').all(),ledger:f.db.prepare('SELECT * FROM billing_transactions').all()});
    await detail(201); // Previewing an older version must not adopt it.
    await f.restart();
    await verify(202);
    assert.equal(JSON.stringify({shots:f.db.prepare('SELECT * FROM omni_video_sequence_shots').all(),ledger:f.db.prepare('SELECT * FROM billing_transactions').all()}),before);
    bind(201); await verify(201);
    bind(null); await verify(null);
    bind(202);
    f.db.prepare('UPDATE omni_video_jobs SET sequence_id=? WHERE id=202').run(sequenceId+100);
    await verify(null);
    f.db.prepare('UPDATE omni_video_jobs SET sequence_id=? WHERE id=202').run(sequenceId);
    f.db.prepare('UPDATE omni_video_sequence_shots SET deleted_at=? WHERE id=?').run(at,shotId);
    assert.equal((await detail(202)).is_current,false);
    f.db.prepare('UPDATE omni_video_sequence_shots SET deleted_at=NULL WHERE id=?').run(shotId);
    f.db.prepare('UPDATE omni_video_sequences SET deleted_at=? WHERE id=?').run(at,sequenceId);
    assert.equal((await detail(202)).is_current,false);
    f.db.prepare('UPDATE omni_video_sequences SET deleted_at=NULL WHERE id=?').run(sequenceId);
    await verify(202);

    // Project adoption still uses the generation ID, including legacy paths.
    const drama = Number(f.db.prepare('INSERT INTO dramas(title,owner_user_id,created_at,updated_at) VALUES(?,?,?,?)').run('project fixture',f.admin.id,at,at).lastInsertRowid);
    const episode = Number(f.db.prepare('INSERT INTO episodes(drama_id,episode_number,created_at,updated_at) VALUES(?,1,?,?)').run(drama,at,at).lastInsertRowid);
    const storyboard = Number(f.db.prepare('INSERT INTO storyboards(episode_id,storyboard_number,active_video_generation_id,created_at,updated_at) VALUES(?,1,102,?,?)').run(episode,at,at).lastInsertRowid);
    f.db.prepare('UPDATE video_generations SET drama_id=?,storyboard_id=? WHERE id IN (101,102)').run(drama,storyboard);
    f.db.prepare('UPDATE omni_video_jobs SET storyboard_id=?,sequence_id=NULL,shot_id=NULL WHERE id IN (201,202)').run(storyboard);
    const projectHistory = async () => (await f.request('GET', `/omni-video-jobs?storyboard_id=${storyboard}`,undefined,cookie)).body.data;
    assert.deepEqual((await projectHistory()).filter(x=>x.is_current).map(x=>x.id),[202]);
    assert.equal((await detail(202)).is_current,true);
    f.db.prepare('UPDATE storyboards SET active_video_generation_id=NULL,local_path=? WHERE id=?').run('videos/101.mp4',storyboard);
    assert.deepEqual((await projectHistory()).filter(x=>x.is_current).map(x=>x.id),[201]);
    assert.equal((await detail(201)).is_current,true);
    f.db.prepare('UPDATE storyboards SET active_video_generation_id=0 WHERE id=?').run(storyboard);
    assert.equal((await detail(201)).is_current,false);
    assert.equal((await projectHistory()).some(x=>x.is_current),false);
    f.db.prepare('UPDATE storyboards SET active_video_generation_id=NULL,local_path=NULL WHERE id=?').run(storyboard);
    f.db.prepare('UPDATE video_generations SET local_path=NULL WHERE id IN (101,102)').run();
    assert.equal((await detail(202)).is_current,false,'two missing paths do not mean current');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cost_calls').get().n,0,'reads never call a supplier');
  } finally { await f.close(); }
});
