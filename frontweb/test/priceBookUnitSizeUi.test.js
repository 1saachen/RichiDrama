import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = () => readFile(new URL('../src/views/AdminConsole.vue', import.meta.url), 'utf8')

test('价目草稿使用共享中文编辑器，供应商来源固定计费单位', async () => {
  const admin = await source()
  const editor = await readFile(new URL('../src/components/PriceBookItemsEditor.vue', import.meta.url), 'utf8')
  assert.match(admin, /<PriceBookItemsEditor :items="price.items" :locked="price.rules_locked"/)
  assert.match(editor, /v-model="item.unit_size"[^>]*aria-label="计价单位数量"/)
  assert.match(editor, /v-if="!locked" class="price-editor-fields"/)
  assert.match(editor, /只能调整积分金额/)
})

test('保存价目时只增删 unit_size，其它计价条件原样保留', async () => {
  const admin = await source()
  const helper = admin.match(/function itemConditions\(item\) \{[^}]*\}[^}]*\}/)
  assert.ok(helper, '缺少 itemConditions()')
  const body = helper[0]
  assert.match(body, /\{ \.\.\.priceConditions\(item\) \}/, '必须从既有 conditions_json 复制，不能重建')
  assert.match(body, /if \(size === 1\) delete conditions\.unit_size; else conditions\.unit_size = size/)
  assert.match(admin, /const \{ unit_size, \.\.\.rest \} = item/, 'unit_size 是界面字段，不能提交给后端')
})

test('编辑既有草稿时单位数量回填自 conditions_json', async () => {
  const admin = await source()
  assert.match(admin, /unit_size: Number\(priceConditions\(item\)\.unit_size \|\| 1\)/)
  assert.match(admin, /计价单位数量必须是正整数/, '保存前必须拦住非法值')
})
