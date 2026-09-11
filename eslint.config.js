import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.dsh-lab` holds local-only host test benches (gitignored): never shipped,
  // never linted.
  { ignores: ['**/lib/**', '**/dist/**', '**/node_modules/**', '.dsh-lab/**'] },
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
