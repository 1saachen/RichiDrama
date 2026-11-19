'use strict';

const express = require('express');
const response = require('../response');
const ownership = require('../services/operationsOwnershipService');

module.exports = function operationsOwnershipRoutes(db) {
  const router = express.Router();
  const handle = (action) => (req, res) => {
    try { return response.success(res, action(req)); }
    catch (error) { return response.badRequest(res, error.message); }
  };

  router.get('/', handle(() => ownership.tree(db)));
  router.put('/individual-customers/:id', handle(req => ownership.addIndividualCustomer(db, req.auth.id, req.params.id)));
  router.put('/projects/:id', handle(req => ownership.setProject(db, req.auth.id, req.params.id, req.body || {})));
  router.put('/internal-members', handle(req => ownership.replaceInternalMembers(db, req.auth.id, req.body?.user_ids)));
  router.post('/customers/:id/config-group', handle(req => ownership.ensureCustomerConfigGroup(db, req.auth.id, req.params.id)));
  return router;
};
