import {
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  Stack,
  Stat,
  Table,
  Tag,
  Text,
  Timeline,
} from 'qoder/canvas';

const phaseRows = [
  { phase: 'Phase 0 · 门禁清零', scope: 'lint 三档 / docs:check / state:check / vitest 全部转绿', evidence: '98dbe29', status: '完成' },
  { phase: 'Phase 1 · 流程护栏', scope: 'pre-push 六步门禁、仓库清卫生、E2E 冒烟 3 条、docs:check 进 CI', evidence: '1ba317d', status: '完成' },
  { phase: 'Phase 2 · 扩展性核心', scope: '长任务队列化、LLM 多后端路由、状态巡检、连接池分级、SSE 断线续传', evidence: '7100645 / 5840829 / 8c1f99a+dad6fcd / a7f9e48+c3c84b5 / cffffb8+4c54e84', status: '完成' },
  { phase: 'Phase 3 · 质量纵深', scope: '四率看板、评测集扩容 10→54、知识库漂移检测、strict 全量化', evidence: '02ec6b3 / 5549c2f / cb16724 / 7442c3b', status: '完成' },
  { phase: 'Phase 4 · 战略演进', scope: '方言适配器 / MCP / 配置热更新 / 读写分离 / Redis 化 / 架构预研——六项立项评审', evidence: 'abb7905（评审记录入档）', status: '完成' },
];

const p3DetailRows = [
  { item: '3-1 四率看板', change: 'opsMetrics 加 dataSourceId 过滤 + downRate 周趋势；OpsMetricsPanel 数据源下钻 + 四率趋势图', verify: 'HTTP 实证 11 断言全过', commit: '02ec6b3' },
  { item: '3-2 评测集扩容', change: 'evalCases.jichuang.json 10→54 用例六类分层；checkEvalSet --file/--require；CI 第二道门禁', verify: '46/46 golden 预验证；基线 68.5%（37/54）入档', commit: '5549c2f' },
  { item: '3-3 漂移检测', change: 'driftDetector 快照比对引擎 + kb_drift_watch/events 两表 + 5 端点 + DriftAlertPanel 前端', verify: '单测 12 例 + HTTP 实证 13 断言全过', commit: 'cb16724' },
  { item: '3-4 strict 全量化', change: 'tsconfig.strict.json 全量 src/** strictNullChecks', verify: 'lint:strict 零错误，pre-push+CI 双门禁冻结', commit: '7442c3b' },
];

const gateRows = [
  { gate: 'tsc 三档（主/server/strict）', result: '零错误' },
  { gate: 'vitest 单元测试', result: '67 文件 776 用例全过' },
  { gate: 'docs:check（OpenAPI 同步）', result: '111 端点与路由定义一致' },
  { gate: 'state:check（进程内状态巡检）', result: '全部登记分类，18 条白名单' },
  { gate: '评测集结构门禁（CI）', result: '主集 104 六类 + 宽表集 54 六类双门禁' },
  { gate: 'HTTP 实证（真库真路由）', result: '3-1 十一断言 / 3-3 十三断言全过' },
];

const evalRows = [
  { cat: 'single_agg（单指标聚合）', rate: '94.4%', detail: '17/18' },
  { cat: 'refuse（越权拒答）', rate: '100%', detail: '4/4' },
  { cat: 'subquery（子查询）', rate: '75%', detail: '6/8' },
  { cat: 'clarify（歧义澄清）', rate: '75%', detail: '3/4' },
  { cat: 'multi_dim（多维组合）', rate: '33.3%', detail: '4/12 —— LIMIT 截断口径为主因' },
  { cat: 'time（时间序列）', rate: '37.5%', detail: '3/8 —— 含 5 条运行层噪声（Ollama 超时）' },
];

const timelineEvents = [
  { id: '1', timestamp: 'Phase 0', title: '门禁清零', description: '四道质量门禁全部转绿，提交基线 98dbe29', tone: 'success' as const },
  { id: '2', timestamp: 'Phase 1', title: '流程护栏', description: 'pre-push 六步门禁 + CI 双拦截 + E2E 冒烟，提交 1ba317d', tone: 'success' as const },
  { id: '3', timestamp: 'Phase 2', title: '扩展性核心五项', description: '队列化 / LLM 多后端 / 状态巡检 / 连接池分级 / SSE 续传，导出池打满时交互 32ms 零排队', tone: 'success' as const },
  { id: '4', timestamp: 'Phase 3', title: '质量纵深四项', description: '四率看板 + 评测 54 例基线 68.5% + 漂移检测 + strict 全量化', tone: 'success' as const },
  { id: '5', timestamp: 'Phase 4', title: '战略项立项评审', description: '六项触发条件逐项核查全部暂缓并注明复核时机，评审记录入档 abb7905', tone: 'neutral' as const },
];

export default function PhaseCompletionReport() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>企业级改进计划（Phase 0–4）完成报告</H1>
        <Text tone="secondary" size="small">
          智能问数据分析系统 · 依据 docs/企业级改进计划20260830.md 逐阶段执行 · 2026-08-29 收官
        </Text>
        <Tag tone="success">计划 18 项全部 ☑，无遗留 ☐</Tag>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat value="5/5" label="阶段完成" tone="success" description="Phase 0-4 全阶段收官" />
        <Stat value="18" label="任务项全部勾选" tone="success" description="含 Phase 4 六项立项评审" />
        <Stat value="776" label="单元测试用例" description="67 文件全过（零回归）" />
        <Stat value="111" label="OpenAPI 端点" description="docs:check 与路由定义一致" />
      </Grid>

      <Divider />

      <H2>关键步骤时间线</H2>
      <Timeline events={timelineEvents} />

      <Divider />

      <H2>各阶段成果总览</H2>
      <Table
        columns={[
          { key: 'phase', title: '阶段', role: 'label' },
          { key: 'scope', title: '范围', role: 'description' },
          { key: 'evidence', title: '提交证据', role: 'description' },
          { key: 'status', title: '状态', role: 'metric' },
        ]}
        rows={phaseRows}
        rowTone="success"
      />

      <H2>Phase 3 质量纵深明细（本次收官阶段）</H2>
      <Table
        columns={[
          { key: 'item', title: '任务', role: 'label' },
          { key: 'change', title: '变更内容', role: 'description' },
          { key: 'verify', title: '验证证据', role: 'description' },
          { key: 'commit', title: '提交', role: 'metric' },
        ]}
        rows={p3DetailRows}
      />

      <H2>验证证据（门禁 + 实证）</H2>
      <Table
        columns={[
          { key: 'gate', title: '门禁 / 验证项', role: 'label' },
          { key: 'result', title: '结果', role: 'description' },
        ]}
        rows={gateRows}
        rowTone={['success', 'success', 'success', 'success', 'success', 'success']}
      />

      <H2>3-2 宽表评测基线（54 用例，accuracy 68.5%）</H2>
      <Table
        columns={[
          { key: 'cat', title: '分层', role: 'label' },
          { key: 'rate', title: '准确率', role: 'metric' },
          { key: 'detail', title: '明细与归因', role: 'description' },
        ]}
        rows={evalRows}
        rowTone={['success', 'success', 'neutral', 'neutral', 'warning', 'warning']}
      />

      <Callout type="info" title="Phase 4 评审结论">
        六项战略项（方言适配器 / MCP 工具化 / 配置热更新 / 读写分离 / Redis 化 / 架构预研）触发条件逐项核查后全部暂缓：
        方言两级抽象（SqlDialect）、REDIS_URL 外置支持、连接池分级、任务队列等可扩展性前置投入已在 Phase 2 就绪，
        当前无条件强行实施属过度工程。复核时机：多实例部署上线（联动 4-3/4-5）或第三种数据库接入需求登记（联动 4-1）。
      </Callout>

      <Callout type="success" title="最终结果">
        企业级改进计划 Phase 0-4 全部收官：质量门禁零错误且 CI/pre-push 双拦截防回退；扩展性核心五项落地；
        在线四率周报 + 54 例评测基线（68.5%）+ 知识库漂移检测构成质量纵深闭环；宽表基线暴露的 multi_dim/time
        短板已归因入档《数据资源库智能问数质量提升实操手册》，作为下一阶段知识库与样例库补强方向。
      </Callout>

      <Text tone="secondary" size="small">
        提交链：…cffffb8 → 4c54e84 → 02ec6b3 → bfd79f6 → cb16724 → db1299a → abb7905 → 5549c2f（HEAD）
      </Text>
    </Stack>
  );
}
