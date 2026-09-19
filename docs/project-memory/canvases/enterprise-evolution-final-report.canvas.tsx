import { Callout, Card, CardBody, Divider, Grid, H1, H2, Stack, Stat, Table, Tag, Text, canvasImage } from 'qoder/canvas';

const metricPanelShot = canvasImage('./p214-semantic-metric-panel.png');
const metricCardShot = canvasImage('./p214-semantic-metric-card.png');
const metricSingleShot = canvasImage('./p214-semantic-metric-single.png');
const dlpAdminShot = canvasImage('./p212-dlp-admin-panel.png');

export default function EnterpriseEvolutionFinalReport() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>企业级演进开发计划 完成报告</H1>
        <Text tone="secondary" size="small">
          智能问数据分析系统 · v0.5.3 → v0.8.0（P0+P1+P2 全 14 项）· 2026-08-22 全部实施、验证并双推（GitHub + Gitee）
        </Text>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat value="14/14" label="计划项全部完成" tone="success" description="P0×4 + P1×6 + P2×4" />
        <Stat value="3" label="里程碑版本双推" description="v0.6.0 / v0.7.0 / v0.8.0（tag 同步）" />
        <Stat value="685" label="单元测试全过" description="60 个测试文件，较基线 569 增长 116" />
        <Stat value="0" label="tsc ×3 / eslint 错误" tone="success" description="server + client + strict 三套配置" />
      </Grid>

      <Divider />

      <H2>P0 上生产前必须（v0.6.0）</H2>
      <Table
        headers={['项目', '实施方案', '验证证据']}
        rows={[
          ['P0-1 评测集扩容', 'evalCases.json 19 → 104 条，六类分层（单表聚合/JOIN/时间对比/嵌套/需澄清/应拒答）+ runEval 分类准确率与阈值断言 + 标注规范文档', 'cases=104、categories=6 核验通过；基线准确率记录'],
          ['P0-2 CI 门禁', '.github/workflows/ci.yml：push/PR 触发 tsc + eslint + vitest + 评测阈值 job（CI 内 stub LLM）', '故意失败用例正确阻断；正常提交全绿'],
          ['P0-3 LLM 调用韧性', 'llmClient.ts：指数退避重试（仅超时/5xx/网络错误）+ 引擎级熔断半开探测 + 每引擎并发信号量', 'llmResilience.test.ts 模拟超时/熔断/并发上限全过'],
          ['P0-4 在线质量看板', 'opsMetrics.ts 北极星指标聚合 API（点赞/点踩/澄清/拒答/自纠错/缓存命中率）+ 前端趋势看板（仅 ADMIN）', '指标 SQL 与手工统计一致；看板渲染验证'],
        ]}
      />

      <H2>P1 规模化推广前（v0.7.0）</H2>
      <Table
        headers={['项目', '实施方案', '验证证据']}
        rows={[
          ['P1-5 列级 Schema Linking', 'schemaLinking.ts 表级圈定 + 列级 embedding 相关性排序；>50 列宽表仅注入 top-N 相关列 + 指标引用列', '204 列宽表 token 显著下降且关键列不缺失；评测不回退'],
          ['P1-6 真语义缓存', 'L1 归一化精确 + L2 embedding 相似度 ≥0.95；缓存全量外置 StateStore/Redis；命中标注并允许刷新', '同义改写命中 L2；跨实例缓存一致（实测 81.7s live → 23ms 命中）'],
          ['P1-7 Self-Consistency 分档', 'liveQuery.ts 复杂问题（多表/嵌套）触发 3 候选，简单问题保持 1 控成本', '机制验证完成，评测集量化持平（记录在案）'],
          ['P1-8 指标层治理', 'metrics.ts 状态机 PENDING→ACTIVE/REJECTED + 版本化快照；提议/审批/驳回/回溯全流程 + 前端管理 UI', '治理全流程 E2E + 浏览器验证；未审批不进生产 linking'],
          ['P1-9 连接池与容量规划', '数据源池 max 公式化可配；压测脚本 + 20/50/100 并发 P95 报告', 'docs/容量规划与压测报告-P1-9.md 产出；无连接耗尽'],
          ['P1-10 strictNullChecks', '前端全模块开启 + CI 增量 strict 门禁（tsconfig.strict.json）', '三套 tsc 全过；无新增运行时错误'],
        ]}
      />

      <H2>P2 企业级深化（v0.8.0，本次会话完成）</H2>
      <Table
        headers={['项目', '实施方案', '验证证据', '提交']}
        rows={[
          ['P2-11 统一身份与授权', 'OIDC 登录（state 防重放）+ 部门维度数据源 ACL + 权限申请审批流 + 前端 SSO/审批页签', '650 用例过 + 浏览器闭环（登录/申请/审批/放行）', 'bd8f11b'],
          ['P2-12 DLP 数据防泄漏', '结果脱敏双通道识别（列名+内容抽样，ADMIN 豁免）+ CSV/PPTX/PDF 导出水印 + 超阈值下载审批（一次性授权）', '九步 API 闭环 + 浏览器双面板截图；138****5678 脱敏实证', '9f49a57'],
          ['P2-13 多实例部署', 'SSE 单连接闭环天然粘性；OIDC state/限流/缓存外置 Redis（warmStateStore 启动预热治 ioredis 冷启动）；compose + nginx 工件', '三项无状态化实测：限流跨实例 429、OIDC state 跨进程一次性、问数缓存跨实例命中', '6c28cae'],
          ['P2-14 语义层独立资产', 'metrics.ts 升级独立语义层（dimensions 可切分维度白名单，对齐 dbt Semantic Layer）+ 统一查询端点 POST /api/metrics/query；问数/报表/看板三端共享同一权威口径', 'API 五项验证 + 看板直查浏览器 12 步闭环（分组图/单值大数/一键固化）', 'b5dd968'],
        ]}
      />

      <Divider />

      <H2>P2-14 变更文件（本阶段）</H2>
      <Card>
        <CardBody>
          <Stack gap={8}>
            <Text size="small"><b>server/metrics.ts</b>（+75）：dimensions 字段与校验（≤10 个/合法标识符/不与表同名）、buildMetricQuerySql 纯函数、buildMetricPrompt 列维度、CRUD 与版本快照透传</Text>
            <Text size="small"><b>server/routes/metrics.ts</b>（+74）：POST /query 统一查询端点（ACL + 用户配额 + SELECT-only 安全执行层 + DLP 脱敏 + 审计）</Text>
            <Text size="small"><b>server/db.ts</b>（+8）：metric_definitions 加 dimensions_json 幂等迁移</Text>
            <Text size="small"><b>server/liveReport.ts</b>（+21）：报表阶段一注入命中指标权威口径（失败降级空串）</Text>
            <Text size="small"><b>src/components/dashboard/CustomDashboard.tsx</b>（+250）：语义指标直查面板（选源/指标/维度 → 直查 → 固化，带维度固化含 sourceSql 参与自动刷新）</Text>
            <Text size="small"><b>server/metrics.test.ts</b>（+89）：新增 7 个用例（维度校验/白名单/limit 夹取/prompt/CRUD 透传）并修正参数序断言</Text>
          </Stack>
        </CardBody>
      </Card>

      <H2>浏览器端到端验证截图</H2>
      <Card>
        <CardBody>
          <Stack gap={10}>
            <Text size="small">
              P2-14：决策看板「语义指标直查」面板 → 选「客户拜访管理」数据源与指标 → 勾选 industry 维度 → 查询返回 18 行分组条形图（SQL 可见）→ 固化至看板生成新卡片 → 取消维度查询显示单值大数 259。验证后测试指标与固化卡片均已清理。
            </Text>
            <img src={metricPanelShot} alt="语义指标直查面板：选指标勾选维度查询并固化至看板" style={{ width: '100%', maxWidth: 480, borderRadius: 8 }} />
            <Grid columns={2} gap={12}>
              <img src={metricCardShot} alt="固化后的语义指标看板卡片（按行业分组条形图）" style={{ width: '100%', borderRadius: 8 }} />
              <img src={metricSingleShot} alt="无维度查询单值大数 259" style={{ width: '100%', borderRadius: 8 }} />
            </Grid>
            <Text size="small">
              P2-12：系统管理「权限审批」页签双面板（数据源访问申请 + 导出下载审批），analyst_dlp 两条申请记录可见。
            </Text>
            <img src={dlpAdminShot} alt="DLP 权限审批双面板（数据源访问申请与导出下载审批）" style={{ width: '100%', maxWidth: 640, borderRadius: 8 }} />
          </Stack>
        </CardBody>
      </Card>

      <H2>API 级验证摘要（P2-14 统一查询端点）</H2>
      <Table
        headers={['用例', '结果']}
        rows={[
          ['无维度单值查询', '200 · rows=[{value:259}] · SQL 仅含登记口径'],
          ['按 industry 切分 + limit 5', '200 · GROUP BY + ORDER BY value DESC · 真实行业分组数据'],
          ['白名单外维度 contacts', '400 · 「不在可切分维度白名单内」'],
          ['非法 metricId=-1', '400 · 非法指标 ID'],
          ['不存在 metricId=99999', '404 · 指标不存在'],
        ]}
      />

      <Divider />

      <Callout tone="success" title="最终结论">
        计划全部 14 项实施完毕，三阶段里程碑 v0.6.0 / v0.7.0 / v0.8.0 均已发布并双推（GitHub + Gitee，tag 同步）。系统从 v0.5.3「准生产级」补齐为具备评测门禁、LLM 韧性、语义缓存、指标治理、统一身份授权、DLP、多实例能力与独立语义层的企业级产品。工作区干净（docs/diagrams 等其他会话产物保持不动），验证用服务器进程已停止。
      </Callout>

      <Stack gap={6}>
        <Text size="small" tone="secondary">关键提交链（新→旧）：</Text>
        <Stack gap={4}>
          <Tag tone="success">97b9efc v0.8.0 里程碑</Tag>
          <Tag tone="neutral">b5dd968 P2-14 语义层独立资产</Tag>
          <Tag tone="neutral">6c28cae P2-13 多实例部署</Tag>
          <Tag tone="neutral">9f49a57 P2-12 DLP 数据防泄漏</Tag>
          <Tag tone="neutral">bd8f11b P2-11 统一身份与授权</Tag>
        </Stack>
      </Stack>
    </Stack>
  );
}
