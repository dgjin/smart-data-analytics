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
      // 新增代码立即被门禁拦截；存量债务经下方 overrides 目录级豁免过渡，清零后移除豁免。
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
  // any 存量豁免（只减不增）：白名单为待清零文件（含当前处数），批次清零后从列表移除；
  // 移出即回到 error 保护，新增文件不在列表 → 立即被门禁拦截。
  // 批次1 已完成（2026-09-15）：server/routes 全目录 130 处 → 0，24 个文件已移出。
  {
    files: [
      'server.ts', // 2
      'server/agent/orchestrator.ts', // 11
      'server/analytics/whatIf.ts', // 2
      'server/anomalyPatrol.ts', // 2
      'server/auth/accessControl.ts', // 1
      'server/auth/oidc.ts', // 3
      'server/dataVersion.ts', // 3
      'server/driftDetector.ts', // 1
      'server/infra/createAbTestTable.ts', // 3
      'server/infra/db.ts', // 1
      'server/infra/envConfigSync.ts', // 1
      'server/infra/health.ts', // 1
      'server/infra/migration.ts', // 17
      'server/infra/monitoring.ts', // 1
      'server/infra/secretsCrypto.ts', // 1
      'server/infra/shutdown.ts', // 1
      'server/infra/taskQueue.ts', // 6
      'server/knowledge/externalKnowledge.ts', // 3
      'server/knowledge/knowledgeBaseTools.ts', // 1
      'server/knowledge/knowledgeServices.ts', // 4
      'server/llm/expertPersona.ts', // 2
      'server/llm/llmResilience.ts', // 2
      'server/llm/llmUsage.ts', // 2
      'server/query/analysisChain.ts', // 12
      'server/query/conversationHistory.ts', // 1
      'server/query/dlp.ts', // 4
      'server/query/drill.ts', // 7
      'server/query/fileDataSource.ts', // 1
      'server/query/ironRules.ts', // 6
      'server/query/liveQuery.ts', // 3
      'server/query/liveQueryParsers.ts', // 1
      'server/query/liveQueryUtils.ts', // 11
      'server/query/metrics.ts', // 13
      'server/query/queryCache.ts', // 4
      'server/query/queryFeedback.ts', // 11
      'server/query/queryHooks.ts', // 1
      'server/query/queryPlan.ts', // 3
      'server/query/queryService.ts', // 12
      'server/query/queryTrace.ts', // 1
      'server/query/simulatedQuery.ts', // 5
      'server/query/sqlExecutor.ts', // 14
      'server/report/liveReport.ts', // 3
      'server/report/reportExport.ts', // 9
      'server/report/simulatedReport.ts', // 3
      'server/seedDataResources.ts', // 2
      'server/serverFallbacks.ts', // 8
      'server/taskHandlers.ts', // 4
      'server/utils/abTest.ts', // 10
      'server/utils/activeLearning.ts', // 2
      'server/utils/fallback/fallbackPipeline.ts', // 5
      'server/utils/fallbackStrategies/simplerPrompt.ts', // 6
      'server/utils/fewShotService.ts', // 4
      'src/components/Header.tsx', // 1
      'src/components/admin/ABTestDashboard.tsx', // 2
      'src/components/admin/AccessRequestsPanel.tsx', // 2
      'src/components/admin/AdminPanel.tsx', // 6
      'src/components/admin/DlpDownloadPanel.tsx', // 2
      'src/components/admin/DriftAlertPanel.tsx', // 3
      'src/components/admin/EnvironmentConfigPanel.tsx', // 2
      'src/components/admin/ExpertPersonasPanel.tsx', // 4
      'src/components/admin/FallbackApprovalPanel.tsx', // 4
      'src/components/admin/IronRulesPanel.tsx', // 10
      'src/components/admin/LlmUsagePanel.tsx', // 1
      'src/components/admin/MetricsPanel.tsx', // 11
      'src/components/admin/OpsMetricsPanel.tsx', // 2
      'src/components/admin/PatrolPanel.tsx', // 5
      'src/components/admin/ReportTemplateManager.tsx', // 4
      'src/components/analytics/AttributionView.tsx', // 1
      'src/components/analytics/ForecastView.tsx', // 1
      'src/components/analytics/WhatIfView.tsx', // 1
      'src/components/auth/ForceChangePassword.tsx', // 1
      'src/components/auth/Login.tsx', // 1
      'src/components/charts/ChartCustomizer.tsx', // 1
      'src/components/charts/DataTable.tsx', // 1
      'src/components/charts/DynamicChart.tsx', // 8
      'src/components/dashboard/CustomDashboard.tsx', // 2
      'src/components/datasource/DataSourceManager.tsx', // 11
      'src/components/datasource/ExternalKnowledgeCard.tsx', // 4
      'src/components/datasource/KnowledgeBasePanel.tsx', // 10
      'src/components/datasource/SchemaMetaEditor.tsx', // 1
      'src/components/datasource/SqlExamplesPanel.tsx', // 10
      'src/components/flexquery/PreviewPanel.tsx', // 1
      'src/components/flexquery/flexQueryShared.ts', // 1
      'src/components/flexquery/hooks/useFlexQueryState.ts', // 3
      'src/components/help/HelpModal.tsx', // 1
      'src/components/query/AnalysisTracePanel.tsx', // 1
      'src/components/query/QueryChat.tsx', // 2
      'src/components/query/SQLPreviewModal.tsx', // 2
      'src/components/query/SkillLibraryModal.tsx', // 4
      'src/components/query/hooks/useSendQuery.ts', // 8
      'src/components/reports/DrillModal.tsx', // 1
      'src/components/reports/ExecutiveReportCard.tsx', // 4
      'src/components/reports/QueryReportCenter.tsx', // 2
      'src/components/reports/ReportGenerator.tsx', // 5
      'src/hooks/useSpeechInput.ts', // 3
      'src/types/analytics.ts', // 3
      'src/utils/apiFetch.ts', // 1
      'src/utils/asyncTask.ts', // 2
      'src/utils/chartThemes.ts', // 1
      'src/utils/exportCsv.ts', // 1
      'src/utils/queryResultNormalizer.ts', // 14
      'src/utils/reportRegen.ts', // 3
      'src/utils/sseStream.ts', // 4
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
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
