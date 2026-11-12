import request from '@/utils/request'

const endpoint = '/video-upscales'
const options = { errorHandledLocally: true }

export const videoUpscales = {
  list(before) { return request.get(endpoint, { ...options, params: { before } }) },
  get(id) { return request.get(`${endpoint}/${id}`, options) },
  upload(file, onUploadProgress) {
    const data = new FormData()
    data.append('file', file)
    data.append('name', file.name)
    return request.post(endpoint, data, {
      ...options, headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
    })
  },
  quote(id, target) {
    return request.post(`${endpoint}/${id}/quote`, { target_resolution: target }, options)
  },
  submit(id, target, amountMicro) {
    return request.post(`${endpoint}/${id}/submit`, {
      target_resolution: target, amount_micro: amountMicro,
    }, options)
  },
  media(id, kind) { return `/api/v1${endpoint}/${id}/media/${kind}` },
}
