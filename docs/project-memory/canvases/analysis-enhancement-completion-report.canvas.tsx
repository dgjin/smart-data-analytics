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
  canvasImage,
} from 'qoder/canvas';

const shotLogin = canvasImage('./verify-step1-after-login.png');
const shotToggles = canvasImage('./verify-step2-query-toggles.png');
const shotReportHeader = canvasImage('./verify-step3-report-card-header.png');
const shotPptDownload = canvasImage('./verify-step3-after-ppt-download.png');

export default function AnalysisEnhancementCompletionReport() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>分析过程增强五项功能 · 完成报告</H1>
        <Row gap={8}>
          <Tag tone="success">全部里程碑完成</Tag>
          <Tag tone="info">智能问数分析系统 · NL2SQL Pro</Tag>
          <Text tone="secondary" size="small">
            Spec：分析过程增强五项功能_task-281 · v0.2
          </Text>
        </Row>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat value="5 / 5" label="功能里程碑交付" tone="success" />
        <Stat value="269 / 269" label="Vitest 用例通过（28 文件）" tone="success" />
        <Stat value="0" label="tsc 类型错误" tone="success" />
        <Stat value="9 项" label="API 冒烟全部通过" tone="success" />
      </Grid>

      <Divider />

      <H2>成果摘要</H2>
      <Table
        headers={['里程碑', '交付内容', '状态']}
        rows={[
          [
            'M1 推导过程记录与可视化',
            'query_trace 表 + liveQuery 全链路埋点 + trace API（鉴权）；前端横向步骤器 + 消息内「推导过程」垂直时间线回放',
            '完成',
          ],
          [
            'M2 问数计划模式',
            'POST /api/query/plan 生成计划（不执行）→ 内存存储 10min TTL 一次性消费 → 批准后携带 planId 执行；前端计划卡片（批准/修改/取消）',
            '完成',
          ],
          [
            'M3 中间表清洗链',
            '复杂度评估 → 多步清洗物化应用库 ait_* 物理表（注册表 + TTL 24h + 每用户 10 张配额 + 敏感列剔除）→ 最终 SQL 仅引用 ait_* 时改应用库执行；失败不阻断主链路',
            '完成',
          ],
          [
            'M4 报告 PPT/PDF 下载',
            '服务端 pptxgenjs 组装 PPTX（封面/摘要/KPI/每图一页/结论）+ POST /api/report/export（独立 20MB body）；前端 SVG 转 PNG 提交 + 「下载 PPT 简报」按钮；PDF 沿用既有 html2pdf 高清导出与打印',
            '完成',
          ],
          [
            'M4 报告计划批准',
            'POST /api/report/plan 生成报表查询计划 → 批准后携带 reportPlanId 生成（复用 M2 机制：10min TTL / 一次性消费 / 409 拒绝）；前端「先制定计划」开关 + 计划卡片',
            '完成',
          ],
        ]}
      />

      <H2>关键实施步骤</H2>
      <Timeline
        density="compact"
        events={[
          { id: 'm1', timestamp: '阶段 1', title: 'M1 推导记录', description: 'queryTrace 模块、SSE 步骤详情、AnalysisTracePanel 接入 QueryChat', state: 'completed', tone: 'success' },
          { id: 'm2', timestamp: '阶段 2', title: 'M2 计划模式', description: 'queryPlan 存储/消费防重放；冒烟：计划生成、409×2、批准执行 live 成功', state: 'completed', tone: 'success' },
          { id: 'm3', timestamp: '阶段 3', title: 'M3 清洗链', description: 'analysisChain 编排 + 注册表 + 定时清理；修复 LLM 编造表名（prompt 强化逐字引用 Schema）', state: 'completed', tone: 'success' },
          { id: 'm4', timestamp: '阶段 4', title: 'M4 报告导出与计划', description: 'reportExport（pptxgenjs）+ 导出路由 + PPT 按钮；报告计划 API + 409 + 批准生成 live 3 图', state: 'completed', tone: 'success' },
          { id: 'final', timestamp: '阶段 5', title: '收尾验证', description: 'tsc 0 错 / vitest 269 全过 / 浏览器端到端下载 PPT 成功 / 文档同步（说明书 v0.2 + README + 主引擎校正为 Ollama）', state: 'completed', tone: 'success' },
        ]}
      />

      <H2>变更文件（主要）</H2>
      <Table
        headers={['层', '文件', '变更']}
        rows={[
          ['后端', 'server/queryTrace.ts · queryPlan.ts · analysisChain.ts · reportExport.ts', '新建：推导埋点 / 计划存储 / 清洗链 / PPTX 组装'],
          ['后端', 'server/liveQuery.ts · liveReport.ts', '埋点 + 计划注入 + 清洗链集成；报表阶段一拆分 + 报告计划存储 + 表名约束强化'],
          ['后端', 'server.ts · db.ts · sqlExecutor.ts', 'plan/export 路由 + 409 校验 + 清理调度；注册表；maxRows 参数'],
          ['前端', 'QueryChat.tsx · AnalysisTracePanel.tsx', '计划/深度分析开关 + 计划卡片；步骤器与时间线'],
          ['前端', 'ReportGenerator.tsx · ExecutiveReportCard.tsx', '报表计划模式开关与计划卡片；「下载 PPT 简报」按钮（SVG→PNG）'],
          ['测试', 'queryTrace/queryPlan/analysisChain/reportExport/liveReport .test.ts', '新增 5 个测试文件，基线 226 → 269 用例'],
          ['文档', 'docs/系统功能说明书.md · README.md', '§3.1/§3.2/§4/§7 更新、§5 主引擎校正为 Ollama、§9 追加 v0.2'],
        ]}
      />

      <H2>验证证据</H2>
      <Table
        headers={['验证项', '结果']}
        rows={[
          ['tsc --noEmit', '0 错误'],
          ['vitest run', '28 文件 / 269 用例全部通过'],
          ['PPT 导出冒烟', '200 + 合法 ZIP（PK 魔数，80KB）；非法参数 400；无鉴权 401'],
          ['问数/报表计划 409', '伪造 planId、问题/模板/数据源不匹配、过期、越权均拒绝'],
          ['计划批准端到端', '问数：按部门聚合 15 行；报表：provenance=live，3 张真实数据图表'],
          ['M3 清洗链端到端', 'ait_* 物化 259 行 + 注册表落地（expires +24h）+ 最终 SQL 在应用库执行 23 行'],
          ['浏览器端到端', '登录 → 问数页双开关存在 → 报表页计划开关 + PPT/PDF 按钮 → 点击「下载 PPT 简报」触发 131KB .pptx 下载，无控制台错误'],
        ]}
      />

      <Grid columns={2} gap={16}>
        <Stack gap={8}>
          <Text weight="semibold">问数页：先制定计划 / 深度分析开关</Text>
          <img src={shotToggles} alt="问数输入区两个开关按钮" style={{ width: '100%', borderRadius: 8 }} />
        </Stack>
        <Stack gap={8}>
          <Text weight="semibold">报表卡片：PPT / PDF 导出按钮</Text>
          <img src={shotReportHeader} alt="报表卡片头部含下载 PPT 简报按钮" style={{ width: '100%', borderRadius: 8 }} />
        </Stack>
        <Stack gap={8}>
          <Text weight="semibold">登录成功</Text>
          <img src={shotLogin} alt="登录后主界面" style={{ width: '100%', borderRadius: 8 }} />
        </Stack>
        <Stack gap={8}>
          <Text weight="semibold">PPT 下载触发后无错误提示</Text>
          <img src={shotPptDownload} alt="点击下载 PPT 后页面无错误" style={{ width: '100%', borderRadius: 8 }} />
        </Stack>
      </Grid>

      <Callout tone="success" title="最终结果">
        Spec 五项功能全部交付并通过逐项证据验证：推导可视化、问数计划模式、中间表清洗链、报告 PPT/PDF
        下载与报告计划批准。安全基线未变（SELECT-only、敏感列过滤、审计落账沿用），所有增强均以开关控制、默认行为不变。
      </Callout>
    </Stack>
  );
}
