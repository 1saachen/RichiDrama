import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeJob, resolveShotPreviewJob, previewVersionLabel, markCurrentHistoryJob, isCurrentProjectVideo } from '../src/utils/shotPreview.js'

test('standalone current versions and explicit historical previews have different labels', () => {
  const current = normalizeJob({ id:202, video_generation_id:102, is_current:true, generation:{id:102,status:'completed',local_path:'videos/current.mp4'} })
  const older = normalizeJob({ id:201, video_generation_id:101, is_current:false, generation:{id:101,status:'completed',local_path:'videos/older.mp4'} })
  const history = [current,older]
  assert.equal(previewVersionLabel(resolveShotPreviewJob(history,null,202)),'当前采用：')
  assert.equal(previewVersionLabel(resolveShotPreviewJob(history,201,202)),'历史预览：')
  assert.equal(current.is_current,true,'preview selection cannot change the adopted version')
  assert.equal(older.is_current,false)
  assert.equal(previewVersionLabel(null),'成片预览：')
})

test('copied playback remains a reference even if its source is current elsewhere', () => {
  const reference = {id:'video-102',video_generation_id:102,is_playback_reference:true,is_current:true}
  assert.equal(previewVersionLabel(reference),'预览引用：')
  markCurrentHistoryJob([reference],reference.id)
  assert.equal(reference.is_current,false)
})

test('new submission or polling adoption clears stale flags only in the supplied shot history', () => {
  const history = [{id:201,video_generation_id:101,is_current:true},{id:202,video_generation_id:102,is_current:true}]
  const anotherShot = [{id:301,is_current:true}]
  markCurrentHistoryJob(history,'202')
  assert.deepEqual(history.map(x=>x.is_current),[false,true])
  assert.equal(previewVersionLabel(history[0]),'历史预览：')
  assert.equal(previewVersionLabel(history[1]),'当前采用：')
  assert.equal(anotherShot[0].is_current,true)
  markCurrentHistoryJob(history,null)
  assert.deepEqual(history.map(x=>x.is_current),[false,true])
})

test('project preview keeps adoption on the generation ID while labeling older previews honestly', () => {
  const history = [{id:202,video_generation_id:102,is_current:true,status:'completed',videoUrl:'/static/current.mp4'},{id:201,video_generation_id:101,is_current:false,status:'completed',videoUrl:'/static/older.mp4'}]
  assert.equal(previewVersionLabel(resolveShotPreviewJob(history,null,102,null,true)),'当前采用：')
  assert.equal(previewVersionLabel(resolveShotPreviewJob(history,201,102,null,true)),'历史预览：')
})

test('legacy project videos retain adoption without an Omni snapshot and never match two empty paths', () => {
  const current = { id:102,local_path:'current.mp4' }, older = {id:101,local_path:'older.mp4'}
  const explicit = {active_video_generation_id:102,local_path:'older.mp4'}
  assert.equal(isCurrentProjectVideo(current,explicit),true)
  assert.equal(isCurrentProjectVideo(older,explicit),false,'explicit adoption wins over a stale path')
  assert.equal(previewVersionLabel({...current,is_current:isCurrentProjectVideo(current,explicit)}),'当前采用：')
  assert.equal(isCurrentProjectVideo(older,{active_video_generation_id:null,local_path:'older.mp4'}),true)
  assert.equal(isCurrentProjectVideo(older,{active_video_generation_id:0,local_path:'older.mp4'}),false)
  assert.equal(isCurrentProjectVideo({id:101,local_path:null},{local_path:null}),false)
})
