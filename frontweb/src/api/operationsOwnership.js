import request from '@/utils/request'

const base = '/admin/ownership'
const options = { errorHandledLocally: true }

export const operationsOwnershipAPI = {
  list: () => request.get(base, options),
  assignProject: (id, data) => request.put(`${base}/projects/${id}`, data, options),
  setInternalMembers: (userIds) => request.put(`${base}/internal-members`, { user_ids: userIds }, options),
  addIndividualCustomer: (id) => request.put(`${base}/individual-customers/${id}`, {}, options),
  createCustomerGroup: (id) => request.post(`${base}/customers/${id}/config-group`, {}, options),
}
