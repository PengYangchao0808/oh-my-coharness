// subagent-result.js — oh-my-dsh-slim companion plugin (PLAN-BACKGROUND-DELEGATION 方案 4).
//
// A single read-only tool `subagent_result`: return the final assistant
// message of an already-settled subagent WITHOUT resuming it. The stock
// alternatives both cost a model turn: `send_message` wakes the child and
// starts a new turn, and the settlement notice only delivers once. OMO's
// equivalent is its `task_result` tool.
//
// This file MUST stay a standalone singleton row in the preset's row list. It
// must never be folded into roles.js: that file is applied once per role
// row (6x), and registering the same globally-named tool twice throws
// `tool "..." is already registered` (dsh-tools NamedEntries), which fails the
// whole preset mount.
//
// Data path (verified by the now-retired scripts/probe-session-query.js,
// 2026-08-21):
// ctx.get('sessionQuery') is mounted by dsh-base (session-query-sqlite,
// openAt: never) — exact reads work everywhere, only full-text search is
// disabled. readSurface(id) resolves live-preferred and falls back to session
// persistence after the child left the store; sessions are never auto-deleted.
// Authorization compares the header's parentSession against the calling
// agent's own session id, so a session can only read lanes it spawned itself.
//
// Dependency resolution goes through ./bridge.js: a preset row cannot
// bare-import @deepseek-ai/* without resolving a stale copy out of the user's
// global node_modules, so bridge.js imports the host's own module instances
// under the host's base URL. This is safe at row-apply time for
// dsh-tools/dsh-session (both are fully loaded before any preset row applies);
// do NOT copy the pattern for packages loaded late in boot.

import { hostImport } from './bridge.js';
import { roleIdFromEvents } from './roles.js';

const name = 'subagent-result';
// `loader` is the host's module loader: the only component that can resolve
// @deepseek-ai/dsh-* for a plugin that lives outside the DSH installation.
const inject = ['tools', 'loader'];

export function latestOwnAssistant(snapshot) {
  // Inherited parent messages are not evidence that the child answered.
  for (let i = snapshot.events.length - 1; i >= 0; i--) {
    const event = snapshot.events[i];
    if (event.seq < (snapshot.inheritedEventCount ?? 0)) continue;
    if (event.type !== 'assistant/message') continue;
    const text = assistantText(event);
    if (text !== '') return { kind: 'result', seq: event.seq, text };
  }
  return undefined;
}

function assistantText(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/**
 * Build the stable RoleResult envelope for one already-settled child read.
 * The message alone is not a settlement proof, so `complete` stays false and
 * `state` names exactly what this read established.
 */
export function buildRoleResult(snapshot, subagentId, readAt = new Date().toISOString()) {
  const found = latestOwnAssistant(snapshot);
  const roleId = roleIdFromEvents(snapshot?.events ?? []) ?? '';
  const capturedThroughSeq = snapshot?.capturedThroughSeq ?? 0;
  if (!found) {
    return {
      kind: 'no-assistant-message',
      subagentId,
      roleId,
      state: 'unknown',
      complete: false,
      capturedThroughSeq,
      readAt,
    };
  }
  return {
    ...found,
    subagentId,
    roleId,
    state: 'message-observed',
    complete: false,
    capturedThroughSeq,
    readAt,
  };
}

async function apply(ctx) {
  const [tools, session] = await Promise.all([
    hostImport(ctx, '@deepseek-ai/dsh-tools'),
    hostImport(ctx, '@deepseek-ai/dsh-session'),
  ]);
  const { defineTool } = tools;
  const { SessionId } = session;
  const dispose = ctx.effect(() => ctx.tools.register(defineTool({
    name: 'subagent_result',
    description: [
      'Read-only retrieval of a local background subagent\'s latest own assistant message; a message alone is not proof the run has settled.',
      'Returns the last assistant message the subagent produced, without waking it up and without starting a new model turn (unlike send_message, which resumes the child).',
      'Use it after a settlement notice to re-read a finished lane\'s outcome, or to collect several finished lanes one by one.',
      'Only direct children of your own session can be read. For OMC external child ids use coharness({action:"result",task_id:"..."}); external runs have no local transcript.',
      'If there is no own assistant message, its state is unknown from this read; consult the settlement notice instead of assuming it is still running or repeatedly polling.',
    ].join(' '),
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The durable subagent id returned when you started the background subagent.',
      },
    },
    output: {
      schema: { oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'result' },
            subagentId: { type: 'string', required: true },
            roleId: { type: 'string', required: true },
            state: { type: 'string', required: true, const: 'message-observed' },
            complete: { type: 'boolean', required: true, const: false },
            seq: { type: 'number', required: true },
            text: { type: 'string', required: true },
            capturedThroughSeq: { type: 'number', required: true },
            readAt: { type: 'string', required: true },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'no-assistant-message' },
            subagentId: { type: 'string', required: true },
            roleId: { type: 'string', required: true },
            state: { type: 'string', required: true, const: 'unknown' },
            complete: { type: 'boolean', required: true, const: false },
            capturedThroughSeq: { type: 'number', required: true },
            readAt: { type: 'string', required: true },
          },
        },
      ] },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'result'
          ? `${value.roleId || 'subagent'} ${value.subagentId} · state ${value.state} · not proof of settlement:\n${value.text}`
          : `${value.roleId || 'subagent'} ${value.subagentId} · state ${value.state}; no own assistant message available (captured through seq ${value.capturedThroughSeq})`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('subagent_result requires a calling agent (exec.agent was undefined)');
      const query = ctx.get('sessionQuery');
      if (query === void 0) {
        throw new Error('subagent_result: ctx.sessionQuery is not mounted (load @deepseek-ai/dsh-session-query-sqlite)');
      }
      let snapshot;
      try {
        snapshot = await query.readSurface(SessionId(args.subagent_id));
      } catch (error) {
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          throw new Error(`subagent_result: no session "${args.subagent_id}" — check the id recorded when the subagent started`);
        }
        throw error;
      }
      // Authorization: only lanes this session spawned itself. The header is
      // immutable creation metadata, so parentSession is the spawn-time truth.
      if (snapshot.session.parentSession !== parent.id) {
        throw new Error(`subagent_result: session "${args.subagent_id}" is not a direct child of this session`);
      }
      return buildRoleResult(snapshot, args.subagent_id);
    },
  })), 'subagent-result: tool');
  // The tool stays registered for the fiber's lifetime; the cordis effect owns
  // disposal. `dispose` is intentionally unused afterwards.
  void dispose;
}

export { name, inject, apply };
