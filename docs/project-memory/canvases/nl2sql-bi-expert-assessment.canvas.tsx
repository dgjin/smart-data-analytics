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
  BarChart,
} from 'qoder/canvas';

const dims = [
  { dimension: 'NL2SQL 核心链路', score: 8.5 },
  { dimension: '安全与治理', score: 9.0 },
  { dimension: '可解释性与信任', score: 8.5 },
  { dimension: '知识与语义层', score: 6.5 },
  { dimension: '报表与呈现', score: 7.5 },
  { dimension: '工程质量', score: 8.0 },
  { dimension: '性能与扩展性', score: 5.5 },
  { dimension: '企业就绪度', score: 6.0 },
];

export default function Nl2sqlBiExpertAssessment() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>智能问数分析系统 · 专家评估报告</H1>
        <Row gap={8}>
          <Tag tone="success">综合评分 7.4 / 10</Tag>
          <Tag tone="info">评估视角：智能问数（NL2SQL）与 BI</Tag>
          <Tag tone="neutral">评估日期 2026-08</Tag>
        </Row>
        <Text tone="secondary" size="small">
          评估依据：全量代码走查（约 1.86 万行 TS/TSX，服务端 40+ 模块）、269 个单测全绿、tsc 零错、真实数据源端到端冒烟记录。
        </Text>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat value="8.5" label="NL2SQL 链路完成度" tone="success" />
        <Stat value="9.0" label="安全纵深防御" tone="success" />
        <Stat value="5.5" label="性能与扩展性" tone="danger" />
        <Stat value="6.5" label="语义层成熟度" tone="warning" />
      </Grid>

      <Divider />

      <H2>一、总体评价</H2>
      <Text>
        本项目是一套功能完整度显著超出同规模自研水平的智能问数系统：双阶段 NL2SQL（生成→执行→解读）+ SSE 流式、
        歧义澄清、数据自省、失败重试、Schema Linking 圈表、知识库 RAG、Few-shot 反馈闭环（Vanna 式训练语料沉淀）、
        推导过程全链路回放（traceId）、计划批准模式、多步中间表清洗链（ait_* 物化）、真实数据高管报表与 PPT/PDF 导出，
        主流开源方案（Vanna / DB-GPT / Chat2DB）的核心思想均已消化落地。安全治理是最大亮点：L1-L5 五层防御、
        SELECT-only + 正则/AST 双道 SQL 校验、敏感列过滤、凭据 AES-256-GCM 加密、RBAC 三角色、全量审计。
        主要差距集中在三点：<Text as="span" weight="semibold">缺乏 NL2SQL 准确率评测体系、缺乏受治理的语义指标层、单实例内存态架构限制了横向扩展与生产可用性</Text>。
      </Text>

      <RadarChart
        data={dims}
        angleKey="dimension"
        dataKeys={[{ key: 'score', label: '得分' }]}
        maxValue={10}
        height={320}
      />

      <Divider />

      <H2>二、能力矩阵（与业界主流对标）</H2>
      <Table
        headers={['能力域', '本项目实现', '业界对标', '评价']}
        rows={[
          ['NL→SQL 生成', '双阶段 prompt + 歧义澄清 + 自省探查 + 失败重试 + 方言适配（MySQL/PG/GP）', 'Vanna / DB-GPT 双阶段范式', '成熟，链路完整'],
          ['Schema 召回', '按问题相关性圈表（表名/描述/列描述），表少时全量注入', 'Chat2DB AI 数据集 3.0', '关键词级召回，未用向量'],
          ['知识增强', '知识库 RAG（指标口径/术语）+ sql_examples Few-shot（手工/点赞沉淀/导入）+ 技能库', 'Vanna training data / DB-GPT 知识库', '思路正确，检索粒度偏浅'],
          ['SQL 安全', 'SELECT-only + 禁用关键词正则 + node-sql-parser AST 二道防线 + 表白名单 + LIMIT 钳制', 'DB-GPT SQL 审计', '优于多数开源实现'],
          ['可解释性', 'query_trace 全步骤埋点（SQL/行数/耗时）+ 时间线回放 + 计划批准（10min TTL 一次性消费）', 'ThoughtSpot SpotIQ 解释', '同类少见的完整度'],
          ['深度分析', '复杂度评估 → 多步清洗物化中间表 ait_*（TTL 24h、配额 10 张/人、失败降级不阻断）', 'Databricks Genie 多步推理', '设计克制，工程化良好'],
          ['报表呈现', '真实数据高管简报（KPI/洞察/图表）+ 异常扫描 + 服务端 PPTX + 前端 PDF/打印', 'PowerBI Copilot 叙事报告', '呈现层达标，交互深度不足'],
          ['运维治理', '审计落账 + 请求日志 + 用户配额（20 次/时、并发 1）+ IP 限流 + prompt token 预算', '企业 BI 平台治理', '治理意识强，缺监控指标'],
        ]}
      />

      <Divider />

      <H2>三、突出亮点</H2>
      <Grid columns={2} gap={12}>
        <Callout tone="success" title="安全纵深防御体系（9/10）">
          输入净化（L1）→ RBAC 双层复核（L2）→ 敏感列过滤（L3）→ 历史净化（L4）→ 用户配额（L5），
          叠加正则+AST 双道 SQL 校验与凭据加密。全部服务端强制、不信任前端，符合金融级问数安全基线。
        </Callout>
        <Callout tone="success" title="可解释性与信任链路（8.5/10）">
          每次问数全程埋点可回放，计划模式让用户「先批准再执行」，中间表清洗链每步留痕。
          解决了智能问数落地的最大障碍——业务用户对黑盒 SQL 的不信任。
        </Callout>
        <Callout tone="success" title="反馈闭环设计">
          点赞自动沉淀为 Few-shot 训练语料（FEEDBACK_UP），与手工登记、批量导入统一进 sql_examples 表，
          形成「越用越准」的数据飞轮雏形，这是 Vanna 路线的正确落地方式。
        </Callout>
        <Callout tone="success" title="工程质量（8/10）">
          40+ 服务端模块职责单一、注释清晰记录设计来源与权衡；22 个测试文件 269 用例全绿；
          纯函数化的防御层便于单测；生命周期钩子（queryHooks）为横切扩展预留切面。
        </Callout>
      </Grid>

      <Divider />

      <H2>四、风险与短板（按优先级）</H2>
      <Table
        headers={['级别', '问题', '影响', '建议']}
        rows={[
          ['P0', '缺乏 NL2SQL 准确率评测集', 'prompt/模型任何改动无法量化回归，准确率是问数产品生命线', '基于自有 Schema 建 50-100 条「问题→标准 SQL→期望结果」评测集，以执行准确率（Execution Accuracy）为核心指标纳入 CI'],
          ['P0', '内存态单实例架构', '计划存储、语义缓存、限流、查询槽全在进程内存，无法水平扩展，重启即失', '外置到 Redis（或先抽象存储接口）；SSE 会话粘滞需配合网关处理'],
          ['P1', '缺少受治理的语义指标层', '指标口径靠文本 RAG「软约束」，同一指标不同问法可能算出不同结果', '沉淀结构化指标定义（指标名/计算 SQL 模板/维度/口径），命中指标时走模板而非自由生成，参考 MetricFlow/Headless BI 思路'],
          ['P1', '本地 LLM 延迟 1-5 分钟', 'deepseek-r1:32b 推理慢导致并发限 1、配额 20 次/时，交互体验受制约', 'SQL 生成阶段换用小型专精模型（如 qwen-coder 类）或云端 API，解读阶段保留本地大模型；扩大语义缓存命中'],
          ['P1', '行级权限缺失', 'scope 仅到表/列级，无法按部门/人限制数据行范围', '在 scope 结构中增加行级过滤谓词（如 dept_id = :user_dept），SQL 生成后强制注入 WHERE'],
          ['P2', 'Schema 召回未用向量', '表规模上百后关键词相关性召回率下降', 'env 已预留 EMBED_MODEL，可为表/列描述建 embedding 索引做语义召回'],
          ['P2', '数据源与部署覆盖', '仅 MySQL/PG/GP；无 Docker/CI/监控指标', '按需接入 ClickHouse/Doris/达梦；补 Dockerfile + 健康检查 + Prometheus 指标'],
          ['P2', '报表交互深度', '图表无下钻、联动、维度切换', '在 DynamicChart 上补充点击下钻（自动生成细分问句回问 LLM）'],
        ]}
        rowTone={['critical', 'critical', 'warning', 'warning', 'warning', 'muted', 'muted', 'muted']}
      />

      <BarChart
        categories={dims.map((d) => d.dimension)}
        series={[{ name: '得分（满分 10）', data: dims.map((d) => d.score) }]}
        horizontal
        domain={[0, 10]}
        height={280}
      />

      <Divider />

      <H2>五、改进路线图建议</H2>
      <Timeline
        events={[
          {
            title: '近期（1-2 周）：建立准确率基线',
            description: '构建评测集并跑出首个执行准确率基线；补 Dockerfile 与健康检查；为表/列描述接入 embedding 召回。',
            state: 'current',
          },
          {
            title: '中期（1-2 月）：语义指标层 + 性能',
            description: '结构化指标定义与模板化生成；SQL 生成阶段切换小型专精模型压延迟至 10 秒级；内存态外置 Redis 支持多实例。',
            state: 'upcoming',
          },
          {
            title: '远期（3-6 月）：企业化深化',
            description: '行级权限、图表下钻联动、更多数据源方言、Prometheus 监控与准确率/延迟看板、多租户隔离。',
            state: 'upcoming',
          },
        ]}
      />

      <Divider />

      <H2>六、结论</H2>
      <Callout tone="info" title="专家结论">
        这是一套架构思路正确、安全治理领先、可解释性完整的智能问数系统，已具备中小规模团队内网试点的条件。
        当前定位应为「受控试点」而非「生产推广」：推广前必须补齐准确率评测体系（否则无法承诺可用性 SLA）、
        将性能压至交互级（10 秒内出 SQL）、并以语义指标层解决口径一致性。三项到位后，
        本系统的能力面将不弱于商用智能问数产品的核心功能集。
      </Callout>
      <Text tone="secondary" size="small">
        评估范围：/Users/dgjin/dgjinapp/智能问数据分析系统 · 代码 + 测试 + 文档 + 端到端冒烟证据 · 评分为专家主观判断，供决策参考。
      </Text>
    </Stack>
  );
}
