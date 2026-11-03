/**
 * Durable OMC mailbox.
 *
 * DSH already delivers messages between adjacent live Agents (`send_message`).
 * That path is process-local and needs a live child. This store is the durable
 * complement: a parent can leave a message for a task/lane, another Host can
 * read it after a restart, and an external CLI follow-up can be queued even
 * though the running process cannot be steered mid-turn.
 *
 * It is intentionally not a second scheduler. Delivery to a native child is
 * attempted through the host's own `send_message`; the mailbox records whether
 * that delivery happened. An external run keeps the message queued until the
 * next resume of the same lane consumes it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireFileLockSync } from './file-lock.js'
import { safeSegment } from './state.js'

export const MAILBOX_SCHEMA_VERSION = 1
export const MESSAGE_KINDS = Object.freeze(['note', 'task', 'result', 'question'])
export const MAX_MESSAGES_PER_PARENT = 500

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(temp, file)
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      rmSync(file, { force: true })
      renameSync(temp, file)
    }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* consumed by rename */ }
  }
}

function mailboxError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function text(value, max = 4000) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function blank(parentId) {
  return { schemaVersion: MAILBOX_SCHEMA_VERSION, parentId, nextId: 1, updatedAt: null, messages: {} }
}

function readMailbox(file, parentId) {
  if (!existsSync(file)) return blank(parentId)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || parsed.schemaVersion !== MAILBOX_SCHEMA_VERSION || typeof parsed.messages !== 'object') {
      throw new Error('unsupported mailbox schema')
    }
    return { ...blank(parentId), ...parsed, messages: parsed.messages }
  } catch (error) {
    throw mailboxError('OMC/MAILBOX-CORRUPT', `mailbox is unreadable: ${error?.message ?? error}`)
  }
}

/**
 * @param {{dir?: string, lockTimeoutMs?: number, maxMessages?: number}} [options]
 */
export function createMailbox({ dir, lockTimeoutMs = 10_000, maxMessages = MAX_MESSAGES_PER_PARENT } = {}) {
  const durable = typeof dir === 'string' && dir.trim() !== ''
  const root = durable ? dir : null
  const cache = new Map()

  function fileFor(parentId) {
    return join(root, safeSegment(parentId, 'parent') + '.json')
  }

  function read(parentId) {
    if (!durable) return clone(cache.get(parentId) ?? blank(parentId))
    return readMailbox(fileFor(parentId), parentId)
  }

  function write(parentId, box) {
    box.updatedAt = new Date().toISOString()
    if (!durable) {
      cache.set(parentId, clone(box))
      return
    }
    atomicWrite(fileFor(parentId), JSON.stringify(box, null, 2) + '\n')
  }

  function locked(parentId, fn) {
    if (!durable) return fn()
    const lock = acquireFileLockSync(join(root, safeSegment(parentId, 'parent')), {
      timeoutMs: lockTimeoutMs,
      staleMs: Math.max(30_000, lockTimeoutMs * 2),
      label: 'mailbox',
    })
    try {
      return fn()
    } finally {
      lock.release()
    }
  }

  function prune(box) {
    const rows = Object.values(box.messages)
    if (rows.length <= maxMessages) return
    rows
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, rows.length - maxMessages)
      .forEach((row) => delete box.messages[row.id])
  }

  function view(row) {
    return {
      id: row.id,
      from: row.from,
      to: row.to,
      kind: row.kind,
      taskId: row.taskId,
      lane: row.lane,
      text: row.text,
      createdAt: row.createdAt,
      readAt: row.readAt ?? null,
      deliveredAt: row.deliveredAt ?? null,
      delivery: row.delivery ?? 'queued',
      ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
      ...(Array.isArray(row.injections) && row.injections.length ? { injections: row.injections } : {}),
      ...(row.note ? { note: row.note } : {}),
    }
  }

  function inboxFor(parentId, agentId, { unreadOnly = true, limit = 50 } = {}) {
    const box = read(parentId)
    const rows = Object.values(box.messages)
      .filter((row) => row.to === agentId || row.to === '*')
      .filter((row) => !unreadOnly || !row.readAt)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, Math.max(1, Math.min(200, limit)))
    return rows.map(view)
  }

  return {
    send({ parentId, from, to, text: body, taskId, lane, kind = 'note', note } = {}) {
      if (!parentId) throw mailboxError('OMC/MAILBOX-PARENT', 'a mailbox needs a parent session id')
      const sender = text(from, 120)
      const target = text(to, 120)
      const message = text(body)
      if (sender === '' || target === '') throw mailboxError('OMC/MAILBOX-INVALID', 'from and to are required')
      if (message === '') throw mailboxError('OMC/MAILBOX-INVALID', 'message text is required')
      if (!MESSAGE_KINDS.includes(kind)) throw mailboxError('OMC/MAILBOX-INVALID', `unknown message kind "${kind}"`)
      return locked(parentId, () => {
        const box = read(parentId)
        const id = 'msg-' + String(box.nextId).padStart(6, '0')
        box.nextId += 1
        box.messages[id] = {
          id, from: sender, to: target, kind, text: message,
          taskId: text(taskId, 120) || null,
          lane: text(lane, 120) || null,
          createdAt: new Date().toISOString(),
          readAt: null,
          deliveredAt: null,
          delivery: 'queued',
          note: text(note, 300) || null,
        }
        prune(box)
        write(parentId, box)
        return view(box.messages[id])
      })
    },
    inbox(parentId, agentId, options) {
      return inboxFor(parentId, agentId, options)
    },
    thread(parentId, { taskId, lane, limit = 100 } = {}) {
      const box = read(parentId)
      return Object.values(box.messages)
        .filter((row) => (!taskId || row.taskId === taskId) && (!lane || row.lane === lane))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(-Math.max(1, Math.min(500, limit)))
        .map(view)
    },
    ack(parentId, agentId, ids) {
      const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => text(id, 80)).filter(Boolean))
      return locked(parentId, () => {
        const box = read(parentId)
        let count = 0
        for (const row of Object.values(box.messages)) {
          if (!wanted.has(row.id)) continue
          if (row.to !== agentId && row.to !== '*') continue
          if (!row.readAt) {
            row.readAt = new Date().toISOString()
            count += 1
          }
        }
        if (count > 0) write(parentId, box)
        return { acked: count }
      })
    },
    markDelivered(parentId, id, { delivery = 'delivered', note } = {}) {
      return locked(parentId, () => {
        const box = read(parentId)
        const row = box.messages[id]
        if (!row) throw mailboxError('OMC/MAILBOX-NOT-FOUND', `unknown message "${id}"`)
        row.deliveredAt = new Date().toISOString()
        row.delivery = delivery
        row.note = text(note, 300) || row.note
        write(parentId, box)
        return view(row)
      })
    },
    /**
     * Messages queued for one task/lane, in id order — the batch the next
     * legal re-dispatch of that work injects (A15). Native `send_message`
     * deliveries are already consumed live and stay out of the batch.
     */
    pendingInjections(parentId, { taskId, lane } = {}) {
      const box = read(parentId)
      return Object.values(box.messages)
        .filter((row) => row.delivery === 'queued')
        .filter((row) => (!taskId || row.taskId === taskId) && (!lane || row.lane === lane))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(view)
    },
    /**
     * Record that a message was injected into one attempt's prompt. The
     * injection key (message id + attempt id) makes crash-retries idempotent:
     * re-recording the same pair is a no-op, and a message injected for
     * attempt #2 is never silently reused for attempt #3 — consumption is
     * confirmed per attempt.
     */
    recordInjection(parentId, messageId, { attemptId, promptDigest } = {}) {
      return locked(parentId, () => {
        const box = read(parentId)
        const row = box.messages[messageId]
        if (!row) throw mailboxError('OMC/MAILBOX-NOT-FOUND', `unknown message "${messageId}"`)
        const attempt = text(attemptId, 120)
        if (!attempt) throw mailboxError('OMC/MAILBOX-INVALID', 'recordInjection needs an attemptId')
        const key = `${messageId}@${attempt}`
        const already = (row.injections ?? []).find((entry) => entry.key === key)
        if (already) return { message: view(row), injection: already, duplicate: true }
        const injection = { key, attemptId: attempt, at: new Date().toISOString(),
          ...(promptDigest ? { promptDigest: text(promptDigest, 200) } : {}) }
        row.injections = [...(row.injections ?? []), injection]
        row.deliveredAt = row.deliveredAt ?? injection.at
        row.delivery = 'injected'
        write(parentId, box)
        return { message: view(row), injection, duplicate: false }
      })
    },
    /**
     * Confirm consumption AFTER the receiving attempt's context is durable
     * (the dispatch record exists). An injection without a matching recorded
     * injection is refused — consumption is never assumed (A15).
     */
    confirmConsumed(parentId, messageId, { attemptId } = {}) {
      return locked(parentId, () => {
        const box = read(parentId)
        const row = box.messages[messageId]
        if (!row) throw mailboxError('OMC/MAILBOX-NOT-FOUND', `unknown message "${messageId}"`)
        const attempt = text(attemptId, 120)
        const injected = (row.injections ?? []).some((entry) => entry.attemptId === attempt)
        if (!injected) {
          throw mailboxError('OMC/MAILBOX-NOT-INJECTED',
            `message "${messageId}" was not injected into attempt "${attempt || '?'}"; consumption cannot be confirmed`)
        }
        if (row.delivery === 'consumed' && row.consumedAt) {
          return { message: view(row), duplicate: true }
        }
        row.delivery = 'consumed'
        row.consumedAt = new Date().toISOString()
        row.readAt = row.readAt ?? row.consumedAt
        write(parentId, box)
        return { message: view(row), duplicate: false }
      })
    },
    /** Poll for unread messages without blocking the host for long. */
    async wait(parentId, agentId, { timeoutMs = 1_000, pollMs = 100, unreadOnly = true } = {}) {
      const deadline = Date.now() + Math.max(0, Math.min(30_000, timeoutMs))
      for (;;) {
        const rows = inboxFor(parentId, agentId, { unreadOnly, limit: 20 })
        if (rows.length > 0 || Date.now() >= deadline) return rows
        await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.min(500, pollMs))))
      }
    },
    stats(parentId) {
      const box = read(parentId)
      const rows = Object.values(box.messages)
      return {
        parentId,
        messages: rows.length,
        unread: rows.filter((row) => !row.readAt).length,
        queued: rows.filter((row) => row.delivery === 'queued').length,
        injected: rows.filter((row) => row.delivery === 'injected').length,
        consumed: rows.filter((row) => row.delivery === 'consumed').length,
        updatedAt: box.updatedAt,
      }
    },
    clear(parentId) {
      return locked(parentId, () => {
        write(parentId, blank(parentId))
        return true
      })
    },
  }
}
