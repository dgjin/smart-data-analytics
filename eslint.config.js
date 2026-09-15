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
      // 代码质量优化（阶段0 门禁加固，2026-09-15）：any/console 升级为 error，
      // 新增代码立即被门禁拦截；any 存量已于阶段4 全部清零（业务代码 546 处 → 0），
      // console 存量经下方 overrides 过渡，阶段5 收敛至 logger 门面后移除。
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
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
  },
  // ── 存量债务豁免区（只减不增，清零后移除对应块）────────────────────────
  // any 存量豁免已全部移除（阶段4 完成，2026-09-15）：业务代码 546 处 → 0，
  // 批次1~6 白名单逐批清零后分别移出，any 现由上方 error 规则全量保护。
  // console 存量豁免：基线 34 处 + server.ts 启动日志，阶段5 统一收敛至 logger 门面后移除。
  {
    files: ['server/**/*.ts', 'server.ts', 'src/**/*.tsx', 'src/**/*.ts'],
    rules: {
      'no-console': 'warn',
    },
  },
  // 永久豁免：CLI 评测脚本、单测、E2E、脚本的 console 输出即用户界面/调试信息，属合法用途。
  {
    files: ['server/eval/**/*.ts', '**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.mjs'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
