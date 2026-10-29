import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * Execute the hand-written client bundle against a minimal host shim.
 *
 * The bundle is a ModuleLoader factory, not an ES module: evaluating it with a
 * `require` stub is the same contract the Web host uses, and it keeps the test
 * out of the browser.
 */
export function loadClientBundle() {
  let captured
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  const React = {
    createElement() { return {} },
    Fragment: 'Fragment',
    useState() { return [undefined, () => {}] },
    useEffect() { return undefined },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
  }
  const primitives = { Button: 'Button', Input: 'Input', Modal: 'Modal', Toast: 'Toast' }
  const require = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require ${name}`)
  }
  const source = readFileSync(join(root, 'vendor/omd/npm-package/client/client.js'), 'utf8')
  new Function('require', 'window', source)(require, window)
  if (captured === undefined) throw new Error('the client bundle never called window.__ModuleLoader__.load')
  const exports = captured.factory(require)
  return { definition: captured, exports, source }
}
