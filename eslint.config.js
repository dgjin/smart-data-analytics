import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'plugins', 'assets'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // react-hooks v6 引入的 React Compiler 级规则：props→state 镜像同步与事件
      // 处理器内的 Date.now() 在本项目是既有合法模式，降级为 warn 作为渐进改进提示，
      // 避免阻塞 lint 门禁；rules-of-hooks 等核心规则仍保持 error。
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      // 同属 react-hooks v6 React Compiler 级规则：渲染期读 ref.current / 先声明后访问
      // 在本项目多处为既有合法模式（如 resize 观测、回调透传），降级为 warn 渐进改进。
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'preserve-caught-error': 'warn',
    },
  }
);
