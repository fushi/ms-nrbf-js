import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.lint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic
    },
    rules: {
      'no-duplicate-imports': 'error',
			'prefer-const': 'error',
      'sort-keys': 'error',
      '@stylistic/indent': ['error', 2],
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': 'error',
      // Numeric enums in TypeScript 6 are transparent to `number`; comparing
      // a raw byte read to an enum member is correct and intentional here.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    ignores: ['dist/', 'eslint.config.js'],
  }
);
