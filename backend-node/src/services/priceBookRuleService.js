'use strict';

const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
const suppliers = new Set(['volcengine', 'volces', 'volc', 'richbest']);
function available(db) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_book_rule_snapshots'").get(); }
function snapshot(db, id) { return available(db) ? db.prepare('SELECT * FROM price_book_rule_snapshots WHERE price_book_id=?').get(id) : null; }
function locked(db, book, visited = new Set()) {
  if (!book || visited.has(book.id)) return false;
  visited.add(book.id);
  if (snapshot(db, book.id) || (suppliers.has(book.provider || 'volcengine') && !!(book.system_managed || book.source_sync_id))) return true;
  return !!book.parent_price_book_id && locked(db, db.prepare('SELECT * FROM billing_price_books WHERE id=?').get(book.parent_price_book_id), visited);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'unit_price_points').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}
function rules(items) {
  return items.map(item => {
    const conditions = { ...parse(item.conditions_json), unit_size: Number(parse(item.conditions_json).unit_size || 1) };
    return { service_type: item.service_type, model: item.model, meter: item.meter, conditions: stable(conditions) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function items(db, id) { return db.prepare('SELECT * FROM billing_price_book_items WHERE price_book_id=?').all(id); }
function assertEdit(db, book, proposed, provider = book?.provider) {
  if (!locked(db, book)) return;
  const saved = snapshot(db, book.id);
  const expected = saved ? JSON.parse(saved.rules_json) : rules(items(db, book.id));
  if ((provider || null) !== (book.provider || null) || JSON.stringify(expected) !== JSON.stringify(rules(proposed))) {
    throw new Error('供应商价目只能调整金额，不能增删计费项或修改模型、供应商、计量单位、单位数量和价格档位；更新规则请重新同步供应商价格');
  }
}
function capture(db, bookId) {
  const book = db.prepare('SELECT * FROM billing_price_books WHERE id=?').get(bookId);
  if (!locked(db, book) || !available(db)) return;
  db.prepare('INSERT OR IGNORE INTO price_book_rule_snapshots(price_book_id,version,provider,rules_json,created_at) VALUES (?,1,?,?,?)')
    .run(bookId, book.provider || null, JSON.stringify(rules(items(db, bookId))), new Date().toISOString());
}
module.exports = { locked, rules, assertEdit, capture };
