import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createMailbox } from '../../integration/mailbox.js'

test('messages are durable, targeted and acknowledgeable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omc-mailbox-'))
  try {
    const first = createMailbox({ dir })
    const message = first.send({
      parentId: 'parent', from: 'parent', to: 'child-1', text: 'check the diff',
      taskId: 'task-1', lane: 'lane-1', kind: 'task',
    })
    assert.equal(message.delivery, 'queued')
    assert.equal(first.inbox('parent', 'child-1').length, 1)
    assert.equal(first.inbox('parent', 'child-2').length, 0)

    const second = createMailbox({ dir })
    const rows = second.inbox('parent', 'child-1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].text, 'check the diff')
    assert.equal(second.thread('parent', { taskId: 'task-1' }).length, 1)
    assert.equal(second.ack('parent', 'child-1', [rows[0].id]).acked, 1)
    assert.equal(second.inbox('parent', 'child-1').length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('broadcast, delivery state and bounded wait work', async () => {
  const mailbox = createMailbox()
  const broadcast = mailbox.send({ parentId: 'p', from: 'p', to: '*', text: 'all hands' })
  assert.equal(mailbox.inbox('p', 'any-agent').length, 1)
  mailbox.markDelivered('p', broadcast.id, { delivery: 'native' })
  assert.equal(mailbox.stats('p').queued, 0)
  assert.equal(mailbox.inbox('p', 'any-agent', { unreadOnly: false }).length, 1)
  const empty = await mailbox.wait('empty-parent', 'nobody', { timeoutMs: 80, pollMs: 25 })
  assert.deepEqual(empty, [])
  const found = await mailbox.wait('p', 'any-agent', { timeoutMs: 80, pollMs: 25 })
  assert.equal(found.length, 1)
})

test('invalid targets and empty text are refused', () => {
  const mailbox = createMailbox()
  assert.throws(() => mailbox.send({ parentId: 'p', from: 'p', to: '', text: 'x' }), /from and to/)
  assert.throws(() => mailbox.send({ parentId: 'p', from: 'p', to: 'c', text: '   ' }), /text is required/)
  assert.throws(() => mailbox.send({ parentId: 'p', from: 'p', to: 'c', text: 'x', kind: 'bogus' }), /unknown message kind/)
})
