import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // NestJS injects by constructor parameter type, so those imports must stay value imports.
    // These options make consistent-type-imports aware of emitted decorator metadata.
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
  },
  {
    // Money must never pass through binary floating point. These calls produce or round floats.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Use @innpilot/money for monetary values.' },
        { object: 'Math', property: 'round', message: 'Use @innpilot/money rounding for monetary values.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use @innpilot/money for monetary values.' },
      ],
    },
  },
);
