import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.dsh-lab` holds local-only host test benches and `.tmp-*` unpacked upstream
  // packages (both gitignored): never shipped, never linted.
  { ignores: ['**/lib/**', '**/dist/**', '**/node_modules/**', '.dsh-lab/**', '.tmp-*/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
