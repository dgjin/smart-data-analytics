import {
  Stack,
  Row,
  Grid,
  H1,
  H2,
  Text,
  Divider,
  Stat,
  Table,
  Tag,
  Callout,
  Timeline,
  RadarChart,
} from 'qoder/canvas';

const dims = [
  { dimension: 'NL2SQL 核心链路', score: 9.0 },
  { dimension: '安全与治理', score: 8.0 },
  { dimension: '自主学习闭环', score: 8.5 },
  { dimension: '知识与语义层', score: 8.0 },
  { dimension: '工程质量', score: 7.5 },
  { dimension: '性能与体验', score: 6.5 },
  { dimension: '版本管理', score: 4.0 },
];

export default function ProjectHealthReviewV040() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>项目健康度评审 · 双报告合并版 v0.4.0</H1>
        <Row gap={8}>
          <Tag tone="success">综合评分 7.9 / 10</Tag>
          <Tag tone="info">本轮评审 × 外部评审 合并去重</Tag>
          <Tag tone="warning">全部建议待批准后执行</Tag>
        </Row>
        <Text tone="secondary" size="small">
          合并规则：外部评审 19 条建议逐条代码核实后并入 —— 采纳 15 条、已修复 1 条（对话落库日志，本会话 v0.4.0 已改）、
          失实 2 条（项目无 Dockerfile；src/ 实有 4 个测试文件）、部分采纳 1 条。事实基线：20,434 行业务代码、
          34 文件 / 365 用例全绿、tsc 零错、git 61 文件未提交。评审日期 2026-08-15。
        </Text>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat value="7.9 / 10" label="综合评分" tone="success" />
        <Stat value="5 / 8 / 11" label="合并后 P0 / P1 / P2" tone="warning" />
        <Stat value="365" label="单测用例全绿" tone="info" />
        <Stat value="0" label="TODO / FIXME 残留" tone="success" />
      </Grid>

      <Divider />

      <H2>维度评分</H2>
      <Grid columns={2} gap={16}>
        <RadarChart
          data={dims}
          angleKey="dimension"
          dataKeys={['score']}
          maxValue={10}
          showScaleLabels
          valueSuffix=" 分"
        />
        <Stack gap={8}>
          <Callout tone="success" title="两份评审一致认可">
            八层纵深防御、双阶段真实执行、fail-closed 行级权限（AST 包裹派生表）、StateStore 内存/Redis 双实现、
            scrypt + timingSafeEqual、AES-256-GCM 凭据加密、AsyncLocalStorage 请求级模型路由、SSOT 文档约定。
          </Callout>
          <Callout tone="warning" title="合并后主要风险面">
            运营基本面（默认密码 / 61 文件未提交）→ AI 正确性（反例照抄 / bigram 检索上限）→
            类型安全（strict 未开启）→ 结构债（server.ts 917 行 / QueryChat 1527 行 / 业务 mock 入 store）。
          </Callout>
        </Stack>
      </Grid>

      <Divider />

      <H2>外部评审 19 条 · 核实结论</H2>
      <Table
        headers={['外部条目', '核实结果', '处置']}
        rows={[
          ['server.ts 917 行路由未拆分（query/report/conversation 等仍在主文件）', '属实', '采纳 → P1-4'],
          ['演示模式 200 行 prompt 混在主路由', '属实', '采纳 → P1-5'],
          ['tsconfig 未开 strict，判别联合被迫 x.ok !== true', '属实（grep 无 strict）', '采纳 → P0-4'],
          ['JWT dev 兜底固定串 dev-only-insecure-secret', '属实（auth.ts L28）', '采纳 → P0-5'],
          ['README 测试数字自相矛盾（349 vs 226 vs 评测集 16）', '属实（实际 34 文件/365 用例）', '采纳 → P0-5'],
          ['QueryChat.tsx 单文件 1527 行承载全部问数页逻辑', '属实', '采纳 → P1-6'],
          ['useAnalyticsStore 硬编码 NPA 金融 mock', '属实（NPA_* 常量）', '采纳 → P1-7'],
          ['serverFallbacks 硬编码业务术语', '属实', '采纳 → 并入 P1-7'],
          ['schema 缓存进程内 Map，多实例失效不同步', '属实（schemaContext L28）', '采纳但降级 → P2（当前单实例）'],
          ['缺结构化错误码 { code, error }', '属实', '采纳 → P1-8'],
          ['recordConversation 静默吞异常 .catch(() => {})', '已过时', '不采纳：v0.4.0 当日已改 console.error 落日志'],
          ['缺 OpenAPI/Swagger', '属实', '采纳 → P2'],
          ['secretsCrypto scrypt 未显式提参 + 固定盐', '属实（L17）', '采纳 → P2 微改'],
          ['selfCorrect 多候选串行生成', '属实（L497 for 循环）', '采纳 → P2'],
          ['Dockerfile 未声明非 root 用户', '失实：项目不存在 Dockerfile', '不单列；并入 P2 部署形态项，落地时直接含 USER node + node fetch 探活'],
          ['33 个测试文件全在 server/，src/ 无测试', '部分失实：src/ 实有 4 个（utils 级）', '部分采纳：hooks / 组件级确实缺失 → P2'],
          ['缺 E2E（Playwright）', '属实', '采纳 → P2'],
          ['useAuthStore 跨 store 清 localStorage', '属实（L31/L36）', '采纳 → P2'],
          ['CI 缺 docs 变更记录同步检查', '属实', '采纳 → P2'],
        ]}
        rowTone={[
          'default', 'default', 'warning', 'warning', 'warning', 'default', 'default', 'default', 'default', 'default',
          'success', 'default', 'default', 'default', 'muted', 'muted', 'default', 'default', 'default',
        ]}
      />

      <Divider />

      <H2>合并后 P0 · 立即处理（5 项）</H2>
      <Table
        headers={['#', '事项', '来源', '量级']}
        rows={[
          ['P0-1', '管理员默认密码未修改 → 首登强制改密 + 强度校验', '本轮评审', '0.5 天'],
          ['P0-2', '61 个文件未提交 → 按功能分批 commit（.env* 已正确忽略）', '本轮评审', '0.5 小时'],
          ['P0-3', '反例注入照抄风险 → 反例只给问题+错误原因，不给完整错误 SQL', '本轮评审', '1 天'],
          ['P0-4', 'tsconfig 开启 strict → 先 server 后 src 分阶段迁移，判别联合回归自然写法', '外部 P0-3', '2 天'],
          ['P0-5', '配置漂移：README 数字统一（34/365）、JWT dev 兜底改启动随机+警告、.env.example 占位改注释', '外部 P0-4/5', '0.5 天'],
        ]}
        rowTone={['danger', 'danger', 'danger', 'danger', 'danger']}
      />

      <H2>合并后 P1 · 本迭代（8 项）</H2>
      <Table
        headers={['#', '事项', '来源', '量级']}
        rows={[
          ['P1-1', 'query_feedback 幂等约束（UNIQUE 或 upsert），防刷样例库', '本轮评审', '0.5 天'],
          ['P1-2', 'conversation_history 保留策略 + 检索索引（FULLTEXT ngram / embedding）', '本轮评审', '1 天'],
          ['P1-3', '四路 bigram 检索升级 embedding（nomic-embed-text 已装），bigram 降级', '本轮评审', '2 天'],
          ['P1-4', 'server.ts 拆分：query / report / conversation / dashboard 路由出主文件', '外部 P0-1', '1.5 天'],
          ['P1-5', '演示模式抽出 server/simulatedQuery.ts，主路由只做分发', '外部 P0-2', '0.5 天'],
          ['P1-6', 'QueryChat 拆分：useQueryStream / QueryComposer / MessageList·MessageItem', '外部 P1-6', '2 天'],
          ['P1-7', '业务 mock 出通用层：NPA 数据移 sampleData + serverFallbacks 全走 schema 推导 + DEMO_PRESET 开关', '外部 P1-7/8', '1.5 天'],
          ['P1-8', '结构化错误码 { code, error }，前端按 code 分支', '外部 P1-10', '1 天'],
        ]}
        rowTone={['warning', 'warning', 'warning', 'warning', 'warning', 'warning', 'warning', 'warning']}
      />

      <H2>合并后 P2 · 择机（11 项）</H2>
      <Table
        headers={['#', '事项', '来源']}
        rows={[
          ['P2-1', 'SSE 阶段一 SQL 先行回显（35s 等待感知优化）', '本轮'],
          ['P2-2', 'zustand persist 滚动上限（每源约 200 条）', '本轮'],
          ['P2-3', '部署形态：Dockerfile（非 root + node fetch 探活）或 pm2 + vite build', '本轮 + 外部 P2-15'],
          ['P2-4', 'LLM token / 耗时埋点到 metrics，多引擎成本对比', '本轮'],
          ['P2-5', 'Gemini 通道去留（@google/genai 3 处引用）', '本轮'],
          ['P2-6', 'selfCorrect 多候选 Promise.all 并行化', '外部 P2-14'],
          ['P2-7', 'schema 缓存接 StateStore（短 TTL + 版本号校验），多实例失效同步', '外部 P1-9'],
          ['P2-8', 'scrypt 显式提参（N=2^15, r=8, p=1）+ pepper', '外部 P2-13'],
          ['P2-9', 'E2E：Playwright 登录→选源→问数→看图→导出→越权验证', '外部 P2-17'],
          ['P2-10', '前端 hooks / 组件测试（src 现仅 4 个 utils 级）+ useAuthStore 跨 store 解耦', '外部 P2-16/18'],
          ['P2-11', 'OpenAPI 文档生成 + CI docs 变更记录同步检查', '外部 P1-12 / P2-19'],
        ]}
        rowTone={['muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'muted']}
      />

      <Divider />

      <H2>建议执行顺序</H2>
      <Timeline
        events={[
          {
            id: 'batch-1',
            timestamp: '第一批 · 半天',
            title: '资产保护 + 配置纠偏',
            description: 'P0-2 分批提交 61 文件 → P0-1 管理员改密 → P0-5 README/JWT/.env.example 修正',
            tone: 'danger',
          },
          {
            id: 'batch-2',
            timestamp: '第二批 · 3 天',
            title: '类型安全 + AI 正确性',
            description: 'P0-4 strict 分阶段开启（server 先行，365 用例回归）→ P0-3 反例注入改造（评测集 8 题验证不退化）',
            tone: 'danger',
          },
          {
            id: 'batch-3',
            timestamp: '第三批 · 约 1.5 周',
            title: 'P1 顺序',
            description: 'P1-1 反馈幂等 → P1-2 历史表治理 → P1-3 embedding → P1-4 路由拆分 → P1-5 演示抽出 → P1-6 QueryChat 拆分 → P1-7 mock 出库 → P1-8 错误码',
            tone: 'warning',
          },
          {
            id: 'batch-4',
            timestamp: '第四批 · 择机',
            title: 'P2 体验与演进',
            description: '11 项按需排期：流式前置 / persist 上限 / 部署 / 埋点 / 并行候选 / 缓存同步 / scrypt / E2E / 前端测试 / OpenAPI / docs CI',
            tone: 'info',
          },
        ]}
      />

      <Callout tone="info" title="合并结论">
        双报告视角互补：本轮评审聚焦运营安全与 AI 质量（密码 / 版本 / 反例 / 幂等 / 检索智能化），
        外部评审聚焦代码结构与工程规范（strict / 路由拆分 / 组件拆分 / mock 分离 / 错误码）。
        合并后 24 项待执行、1 项已修复、2 项失实不采纳、1 项部分采纳。均未执行，等待逐项或分批批准。
      </Callout>

      <Text tone="secondary" size="small">
        数据来源：两轮本地实测交叉核实（wc / grep / git status / vitest / ls），评审范围 src + server + server.ts + 配置文件。
      </Text>
    </Stack>
  );
}
