import { hostImport } from '../preset/bridge.js';

/**
 * Register the RPC protocol with the caller's injected context.
 *
 * rc.2's rpc.handle captures the connection provider's context, which cannot
 * read its sibling webServer. The exported host register method accepts an
 * explicit owner instead: use our child so both route registration and cleanup
 * belong to the fiber that actually injected webServer. Keep all transport
 * details (admit, OperatorPeer, schemas, envelopes, abort bridge) in host code.
 *
 * @param child - context that injected `webServer` and `connection`.
 * @param handler - endpoint handler.
 * @param options - { path, importHost }, or the legacy importHost function.
 */
export async function registerProfileTransport(child, handler, options = {}) {
  const { path = '/coharness', importHost = hostImport } = typeof options === 'function'
    ? { importHost: options }
    : options;
  let active = true;
  child.effect(() => () => { active = false; }, 'oh-my-coharness: transport import lifetime');
  const { HostConnectionService } = await importHost(child, '@deepseek-ai/dsh-client-connection');
  if (!active) return;
  const register = HostConnectionService?.prototype?.register;
  if (typeof register !== 'function') {
    throw new Error('oh-my-coharness: host connection does not expose its native RPC registration method');
  }
  return register.call(child.connection, child, path, handler);
}
