const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const source = fs.readFileSync(path.join(__dirname, '../tools/check-release-idle.js'), 'utf8');

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'release-idle-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'test.db');
  const db = new Database(file);
  for (const table of ['async_tasks', 'image_generations', 'video_generations', 'las_media_jobs']) db.exec(`CREATE TABLE ${table}(status TEXT, deleted_at TEXT)`);
  db.close();
  return { file, run() {
    const process = { argv: ['node', '-', file], exitCode: 0 };
    const output = [];
    vm.runInNewContext(source, { require: name => { assert.equal(name, '/app/backend-node/node_modules/better-sqlite3'); return Database; }, process, console: { log: text => output.push(JSON.parse(text)) } });
    return { code: process.exitCode, output };
  }};
}
test('release idle check is read-only and allows an idle database with legacy completed records', t => {
  const f = fixture(t); const db = new Database(f.file);
  db.exec("INSERT INTO video_generations VALUES ('completed', NULL)"); db.close();
  const before = fs.readFileSync(f.file);
  assert.equal(f.run().code, 0);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test('release waits for submissions, deleted active media and finalization, without changing them', t => {
  const f = fixture(t); const db = new Database(f.file);
  db.exec("INSERT INTO video_generations VALUES ('processing','2026-10-01'); INSERT INTO las_media_jobs VALUES ('finalizing',NULL)"); db.close();
  const before = fs.readFileSync(f.file); const result = f.run();
  assert.equal(result.code, 75); assert.equal(result.output[0].active.video_generations, 1); assert.equal(result.output[0].active.las_media_jobs, 1);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test('release fails closed when a required lifecycle table cannot be read', t => {
  const f = fixture(t); const db = new Database(f.file); db.exec('DROP TABLE async_tasks'); db.close();
  assert.throws(() => f.run(), /Required table missing/);
});
