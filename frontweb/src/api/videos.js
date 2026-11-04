import request from '@/utils/request'
import { createClientRequestId } from '@/utils/requestId'

export const videosAPI = {
  get(id) {
    return request.get(`/videos/${id}`)
  },
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  defaultHomepageVideos() {
    return request.get('/homepage/default-videos')
  },
  /** 创建单条分镜视频生成任务，body: { drama_id, storyboard_id, prompt, image_url?, model?, ... } */
  create(body) {
    return request.post('/videos', { ...body, idempotency_key: body?.idempotency_key || createClientRequestId() })
  },
  postprocessQuote(body) {
    return request.post('/videos/postprocess-quote', body)
  },
  drafts(params) { return request.get('/video-drafts', { params }) },
  draftFinalQuote(id) { return request.post(`/video-drafts/${id}/final-quote`, {}) },
  recoverDraft(id) { return request.post(`/video-drafts/${id}/recover`, {}) },
  finalizeDraft(id) { return request.post(`/video-drafts/${id}/finalize`, { idempotency_key: createClientRequestId() }) }
}
