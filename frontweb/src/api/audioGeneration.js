import request from '@/utils/request'

const configPath = '/tools/audio-generation/config'
const jobsPath = '/tools/audio-generation/jobs'
const options = { errorHandledLocally: true }

export const audioGenerationAPI = {
  getConfig() { return request.get(configPath, options) },
  listJobs() { return request.get(jobsPath, options) },
  createJob(prompt, requestId) {
    return request.post(jobsPath, { prompt, request_id: requestId }, options)
  },
}
