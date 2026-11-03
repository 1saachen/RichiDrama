'use strict';
const response = require('../response');
const jobs = require('../services/relayModelJobService');
module.exports = (db,cfg,log) => {
  const handle = fn => async (req,res) => { try { response.success(res,await fn(req)); } catch(e) { response.badRequest(res,e.message); } };
  return {
    models:handle(req=>jobs.models(db,req.auth)),
    quote:handle(req=>jobs.quote(db,req.auth,req.body||{})),
    create:handle(req=>jobs.create(db,log,cfg,req.auth,req.body||{})),
    list:handle(req=>jobs.list(db,req.auth)),
    refresh:handle(req=>jobs.refresh(db,log,cfg,req.auth,req.params.id)),
    get:(req,res)=>{const job=jobs.get(db,req.auth,req.params.id);return job?response.success(res,job):response.notFound(res,'记录不存在');},
  };
};
