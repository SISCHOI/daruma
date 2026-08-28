/**
 * Client bundle build for dsh-daruma (mirrors the harness `tsdown.client.ts`
 * preset and dsh-ssh): emits the browser artifact as a CJS closure registered
 * through `window.__ModuleLoader__.load`, resolves platform modules from the
 * loader module table, and inlines everything else.
 */
import { defineConfig } from 'tsdown'

const ID = 'dsh-daruma'

/** Platform modules the shell shares into the frozen module table. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'lib/client/index.js' },
  // Browser bundle lands next to the node half; the entryFileNames pin keeps
  // it exactly lib/client.js. clean stays off so the node-half output survives.
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (id) => EXTERNALS.includes(id),
    alwaysBundle: (id) => !EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
