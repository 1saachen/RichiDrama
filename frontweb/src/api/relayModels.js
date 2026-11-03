import request from '@/utils/request'
export const relayModelsAPI = {
  models: () => request.get('/relay-models'),
  quote: body => request.post('/relay-generations/quote', body),
  create: body => request.post('/relay-generations', body),
  list: () => request.get('/relay-generations'),
  get: id => request.get(`/relay-generations/${id}`),
  refresh: id => request.post(`/relay-generations/${id}/refresh`),
}
