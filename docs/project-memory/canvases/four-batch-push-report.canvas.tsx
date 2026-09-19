import { Callout, Card, Divider, Grid, H1, H2, Link, Pill, Row, Stack, Stat, Table, Tag, Text } from 'qoder/canvas';

export default function FourBatchPushReport() {
  return (
    <Stack gap={20}>
      <H1>四批企业级改造 · GitHub 推送完成报告</H1>

      <Callout tone="success" title="推送成功">
        <Stack gap={6}>
          <Text>仓库：<Link href="https://github.com/dgjin/smart-data-analytics">github.com/dgjin/smart-data-analytics</Link> · main 分支</Text>
          <Text>范围 760c405..785bdd1，共 19 个提交，fast-forward 无冲突；推送后复核本地与 origin/main 完全同步，工作区干净。</Text>
        </Stack>
      </Callout>

      <Grid columns={4} gap={12}>
        <Stat value="19" label="推送提交（origin/main）" tone="primary" />
        <Stat value="434/434" label="单元测试通过（44 文件）" tone="success" />
        <Stat value="3/3" label="Playwright E2E 通过" tone="success" />
        <Stat value="59" label="OpenAPI 端点同步校验一致" tone="success" />
      </Grid>

      <Divider />

      <H2>四批执行总览</H2>
      <Table
        headers={['批次', '范围', '提交', '核心内容']}
        rows={[
          ['第一批', 'P0 ×3', 'b1-1/2/3', '61 文件分批提交；首登强制改密 + 密码强度校验；README 数字统一 + JWT dev 兜底 + .env.example'],
          ['第二批', 'P0 ×2', 'b2-1/2', 'strict 分阶段开启（server 先行）；反例注入改造（去完整 SQL + 高相似阈值）+ 评测回归'],
          ['第三批', 'P1 ×8', 'c0b0e28 / 2e80cb3 / 91fdf25', '反馈 24h 幂等 + 历史表治理 + embedding 检索；路由拆分 + 演示模式抽出；QueryChat 拆分 + mock 出库 + 统一错误码'],
          ['第四批', 'P2 ×11', '582c881 / d180c68 / d90bef2 / 1c34d38 / 785bdd1', 'SSE SQL 先行回显、persist 滚动上限、多候选并行、LLM 埋点、StateStore 缓存、scrypt 加固、前端测试、OpenAPI、Dockerfile、E2E、Gemini 判定保留'],
        ]}
      />

      <H2>第四批 P2 十一项明细</H2>
      <Table
        headers={['项', '改造', '落地']}
        rows={[
          ['P2-1', 'SSE 阶段一 SQL 先行回显', 'liveQuery sql_gen 后推 stage=sql_ready{sql}，QueryChat 进度区渲染预览，缓解 35s 等待焦虑'],
          ['P2-2', 'zustand persist 滚动上限', 'chatRetention：每数据源 200 条 / 未归属 50 条配额，保留最新'],
          ['P2-3', 'Dockerfile 部署形态', '多阶段构建，运行镜像仅生产依赖 + dist，非 root(node:1000)，node fetch 探活 HEALTHCHECK'],
          ['P2-4', 'LLM token/耗时埋点', 'llm_usage 表四通道埋点（含失败调用），GET /api/system/llm-usage ADMIN 聚合'],
          ['P2-5', 'Gemini 通道判定', '保留：惰性 dynamic import，无密钥零加载零开销，作多引擎容灾'],
          ['P2-6', 'selfCorrect 并行化', 'attempt=1 多候选 Promise.allSettled；attempt=0 保持串行（澄清/自省有状态）'],
          ['P2-7', 'schema 缓存接 StateStore', 'sctx: 前缀 + TTL 300s，多实例失效同步；invalidate 变 async'],
          ['P2-8', 'scrypt 显式提参 + pepper', 'N=2^15/r=8/p=1，7 段格式兼容旧 4 段，maxmem 显式放宽，缺失 fail-closed'],
          ['P2-9', 'Playwright E2E', '3 用例：登录→选源→问数(mock SSE)→看图→导出下载；登录失败文案；越权 403/匿名 401'],
          ['P2-10', '前端 hooks/组件/store 测试', 'configureApiAuth 解耦 client→store 反向依赖；30 用例（jsdom + @testing-library）'],
          ['P2-11', 'OpenAPI 文档', '59 端点全覆盖 + checkOpenapi.mjs 双向比对防漂移（npm run docs:check）'],
        ]}
      />

      <Divider />

      <H2>变更文件分组</H2>
      <Grid columns={2} gap={12}>
        <Card size="sm">
          <Stack gap={8}>
            <Text weight="semibold">服务端（10 文件）</Text>
            <Text size="small" tone="secondary">liveQuery / llmClient / llmUsage(新) / db / schemaContext / passwords / server.ts / routes/datasources / errorCodes 等</Text>
          </Stack>
        </Card>
        <Card size="sm">
          <Stack gap={8}>
            <Text weight="semibold">前端（12 文件）</Text>
            <Text size="small" tone="secondary">QueryChat / Header / client / main / useAnalyticsStore / sseStream / chatRetention(新) + 6 个测试文件</Text>
          </Stack>
        </Card>
        <Card size="sm">
          <Stack gap={8}>
            <Text weight="semibold">工程化（9 文件）</Text>
            <Text size="small" tone="secondary">Dockerfile / .dockerignore / playwright.config / openapi.json(新) / checkOpenapi.mjs(新) / e2e spec(新) / vite.config / package.json / .gitignore / README</Text>
          </Stack>
        </Card>
        <Card size="sm">
          <Stack gap={8}>
            <Text weight="semibold">测试基建</Text>
            <Text size="small" tone="secondary">新增 @testing-library/react + jsdom；vitest exclude tests/e2e；test:e2e 与 docs:check scripts</Text>
          </Stack>
        </Card>
      </Grid>

      <H2>验证证据</H2>
      <Table
        headers={['关卡', '命令 / 方式', '结果']}
        rows={[
          ['类型检查', 'tsc --noEmit（app + server 双配置）', '0 错误'],
          ['单元测试', 'npx vitest run', '44 文件 434/434 通过（基线 404 → +30）'],
          ['E2E', 'npx playwright test', '3/3 通过（2.0s，问数 mock SSE 与 LLM 波动解耦）'],
          ['文档同步', 'npm run docs:check', '59 端点与路由定义双向一致（首跑曾抓 1 遗漏端点）'],
          ['构建产物', 'npm run build + npm ci --dry-run', 'dist/server.cjs 335KB；lock 可装性一致'],
          ['运行冒烟', '重启服务 + curl', '/api/health ok；llm-usage 落库（超时调用 ok=0 亦记录）'],
          ['推送复核', 'git fetch + status -sb', 'main 与 origin/main 同步，HEAD = 785bdd1'],
        ]}
      />

      <Divider />

      <H2>过程关键决策</H2>
      <Stack gap={8}>
        <Text>• E2E 问数 mock 化：真实 LLM 首跑 180s 超时（Qwen 波动），mock SSE 注入后 UI 全链路 2s 稳定；真实链路由服务端评测覆盖。</Text>
        <Text>• Playwright CDN 不可达 → 改用系统 Chrome channel 驱动，规避浏览器下载。</Text>
        <Text>• Docker daemon 未装 → 构建三要素（npm ci dry-run / npm run build / 探活脚本）本地等效验证。</Text>
        <Text>• Gemini 保留判定：惰性加载零开销，作为多引擎容灾备份不删除。</Text>
      </Stack>

      <Row>
        <Tag tone="success">全部完成</Tag>
        <Pill tone="primary">2026-08 · Qoder</Pill>
      </Row>
    </Stack>
  );
}
