// Qoder Token 用量仪表盘 —— Canvas 版
// 由 build_canvas.py 自动生成（数据为 Qoder 本地库的一次只读快照，不自动更新）。
// 刷新方式：在 Chat 中对 Qoder 说「刷新 token 用量 Canvas 仪表盘」，或点击底部「刷新数据」按钮。
import {
  BarChart,
  ChartComparisonGrid,
  ChartContainer,
  H1,
  LineChart,
  MetricsGrid,
  PieChart,
  ReportSection,
  ReportShell,
  Row,
  SendToChatButton,
  Stack,
  Table,
  Tag,
  Text,
  useCanvasState,
} from 'qoder/canvas';
import type { MetricItem, TableColumn } from 'qoder/canvas';

/** 每日聚合点（cost 为参考费用，仅统计已配置单价的模型） */
type DayPoint = {
  label: string;
  cached: number;
  uncached: number;
  output: number;
  cost: number;
};

/** 模型 / 项目维度的聚合行 */
type DimRow = {
  name: string;
  msgs: number;
  prompt: number;
  completion: number;
  cached: number;
  total: number;
  share: number;
  cost: number | null;
};

type RangeSummary = {
  msgs: number;
  prompt: number;
  completion: number;
  cached: number;
  total: number;
  cost: number | null;
  cacheRate: number;
  customTotal: number;
  customShare: number;
};

type RangeData = {
  id: string;
  label: string;
  summary: RangeSummary;
  days: DayPoint[];
  models: DimRow[];
  projects: DimRow[];
  missing: string[];
};

type Payload = {
  generatedAt: string;
  currency: string;
  ranges: RangeData[];
  footnotes: string[];
};

const DATA: Payload = __DATA__;

const fmtTokens = (n: number): string => {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return `${Math.round(n)}`;
};

const fmtMoney = (n: number): string => `¥${n.toFixed(2)}`;
const fmtInt = (n: number): string => n.toLocaleString('en-US');
const fmtPct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const fmtCost = (n: number | null): string => (n === null ? '—' : fmtMoney(n));

const dimColumns: TableColumn<DimRow>[] = [
  { key: 'name', title: '名称', role: 'label', truncate: true },
  { key: 'msgs', title: '消息数', align: 'right', render: (row) => fmtInt(row.msgs) },
  { key: 'prompt', title: '输入', align: 'right', render: (row) => fmtInt(row.prompt) },
  { key: 'completion', title: '输出', align: 'right', render: (row) => fmtInt(row.completion) },
  { key: 'cached', title: '缓存', align: 'right', render: (row) => fmtInt(row.cached) },
  { key: 'total', title: '合计', align: 'right', render: (row) => fmtInt(row.total) },
  { key: 'share', title: '占比', align: 'right', render: (row) => fmtPct(row.share) },
  { key: 'cost', title: '参考费用', align: 'right', render: (row) => fmtCost(row.cost) },
];

export default function TokenUsageDashboard() {
  // 范围切换偏好由 Canvas 持久化记忆（下次打开保持上次选择）
  const [rangeId, setRangeId] = useCanvasState<string>('qoder-token-range', '7');
  const r = DATA.ranges.find((x) => x.id === rangeId) ?? DATA.ranges[0];
  const s = r.summary;
  const dayLabels = r.days.map((d) => d.label);
  const projects = r.projects.slice(0, 10);

  const kpis: MetricItem[] = [
    {
      label: '总 Tokens',
      value: fmtTokens(s.total),
      description: `输入 ${fmtTokens(s.prompt)} · 输出 ${fmtTokens(s.completion)}`,
    },
    {
      label: '参考费用',
      value: s.cost === null ? '—' : fmtMoney(s.cost),
      description: '按官网单价折算（元）',
    },
    {
      label: '消息数',
      value: fmtInt(s.msgs),
      description: `${r.days.length} 个自然日有记录`,
    },
    {
      label: '缓存命中率',
      value: fmtPct(s.cacheRate),
      description: '缓存 Tokens / 输入 Tokens',
    },
    {
      label: '自定义模型占比',
      value: fmtPct(s.customShare),
      description: `${fmtTokens(s.customTotal)}（BYOK）`,
    },
  ];

  return (
    <ReportShell width="wide" ariaLabel="Qoder Token 用量仪表盘">
      <Stack gap="sectionCompact">
        <Stack gap="component">
          <H1>Qoder Token 用量仪表盘</H1>
          <Text tone="secondary">
            官方模型 + 自定义模型（BYOK）· 数据源：Qoder 本地库只读快照 · 参考费用按各模型官网单价折算
          </Text>
          <Row gap="inline" align="center" wrap>
            {DATA.ranges.map((x) => (
              <Tag key={x.id} active={x.id === r.id} onClick={() => setRangeId(x.id)}>
                {x.label}
              </Tag>
            ))}
          </Row>
          <MetricsGrid variant="header" columns={5} items={kpis} />
        </Stack>

        <ReportSection
          title="每日消耗趋势"
          description="按北京时间自然日聚合"
          meta={r.label}
          divided
        >
          <Stack gap="sectionCompact">
            <ChartContainer
              title="每日 Token 消耗"
              description="按输入类型堆叠：缓存输入 + 非缓存输入 + 输出"
              caption="单位：tokens"
            >
              <BarChart
                stacked
                height={260}
                categories={dayLabels}
                series={[
                  { name: '缓存输入', data: r.days.map((d) => d.cached) },
                  { name: '非缓存输入', data: r.days.map((d) => d.uncached) },
                  { name: '输出', data: r.days.map((d) => d.output) },
                ]}
                valueFormatter={fmtTokens}
                accessibilitySummary={`${r.label}每日 Token 消耗堆叠柱状图`}
              />
            </ChartContainer>
            <ChartContainer
              title="每日参考费用"
              description="仅统计已配置单价的模型；DeepSeek 系列按消息时间自动区分高峰/空闲时段"
              caption="单位：元"
            >
              <LineChart
                fill
                height={200}
                categories={dayLabels}
                series={[{ name: '参考费用', data: r.days.map((d) => d.cost) }]}
                valueFormatter={fmtMoney}
                accessibilitySummary={`${r.label}每日参考费用折线图`}
              />
            </ChartContainer>
          </Stack>
        </ReportSection>

        <ReportSection title="构成分布" divided>
          <ChartComparisonGrid plotHeight={260}>
            <ChartContainer title="模型分布" description="按 Tokens 合计" caption={r.label}>
              <PieChart
                donut
                centerLabel="合计"
                data={r.models.map((m) => ({ label: m.name, value: m.total }))}
                valueFormatter={fmtTokens}
                accessibilitySummary={`${r.label}各模型 Token 占比`}
              />
            </ChartContainer>
            <ChartContainer
              title={`项目排行 Top ${projects.length}`}
              description="按 Tokens 合计"
              caption={r.label}
            >
              <BarChart
                horizontal
                height={260}
                categories={projects.map((p) => p.name)}
                series={[{ name: 'Tokens', data: projects.map((p) => p.total) }]}
                valueFormatter={fmtTokens}
                accessibilitySummary={`${r.label}各项目 Token 消耗排行`}
              />
            </ChartContainer>
          </ChartComparisonGrid>
        </ReportSection>

        <ReportSection
          title="按模型明细"
          description="费用为参考估算；无公开单价的官方档位显示为 —"
          divided
        >
          <Table columns={dimColumns} rows={r.models} rowKey="name" density="compact" />
        </ReportSection>

        <ReportSection
          title={`按项目明细（Top ${projects.length}）`}
          description="按 chat_session.project_name 聚合"
          divided
        >
          <Table columns={dimColumns} rows={projects} rowKey="name" density="compact" />
        </ReportSection>

        <ReportSection title="口径与刷新" divided>
          <Stack gap="component">
            {DATA.footnotes.map((f, i) => (
              <Text key={i} size="small" tone="secondary">
                · {f}
              </Text>
            ))}
            <Row gap="component" align="center" wrap>
              <Text size="small" tone="secondary">
                数据快照：{DATA.generatedAt}
              </Text>
              <SendToChatButton
                variant="secondary"
                text="刷新 token 用量 Canvas 仪表盘（重新生成数据）"
              >
                刷新数据
              </SendToChatButton>
            </Row>
          </Stack>
        </ReportSection>
      </Stack>
    </ReportShell>
  );
}
