const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { requestId } = require('../src/services/videoRequestIdentityService');

test('request identity preserves embedded IDs and tolerates legacy databases', () => {
  const db = new Database(':memory:');
  try {
    const row = { billing_authorization_id: 'auth', owner_user_id: 1 };
    assert.equal(requestId(db, row), null);
    assert.equal(requestId(db, { ...row, error_msg: 'failed. Request id: req-original,' }), 'req-original');
    assert.equal(requestId(db, { ...row, provider_request_id: 'explicit', error_msg: 'Request id: req-original' }), 'explicit');
  } finally { db.close(); }
});

test('request identity excludes foreign owners, authorizations, stages and task attempts', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE cost_calls (authorization_id TEXT,user_id INTEGER,service_type TEXT,provider_task_id TEXT,provider_request_id TEXT)');
    const insert = db.prepare('INSERT INTO cost_calls VALUES (?,?,?,?,?)');
    insert.run('auth', 2, 'video', 'task', 'foreign-owner');
    insert.run('other', 1, 'video', 'task', 'foreign-auth');
    insert.run('auth', 1, 'video_upscale', 'task', 'enhancement');
    insert.run('auth', 1, 'video', 'old-task', 'old-attempt');
    const row = { billing_authorization_id: 'auth', owner_user_id: 1, provider_task_id: 'task' };
    assert.equal(requestId(db, row), null);
    insert.run('auth', 1, 'video', 'task', 'req-current');
    assert.equal(requestId(db, row), 'req-current');
    insert.run('auth', 1, 'video', 'task', 'req-conflicting');
    assert.equal(requestId(db, row), null);
    assert.equal(requestId(db, { ...row, error_msg: 'Request id: req-exact-error' }), 'req-exact-error');
  } finally { db.close(); }
});
