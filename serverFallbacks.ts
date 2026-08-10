/**
 * 离线/降级响应生成器
 * 当 LLM（Ollama 或 Gemini）不可用时，提供确定性的演示数据，
 * 保证界面可用性。前端会通过 isFallback 标记明确告知用户。
 * 传入 schema 时，指标与维度从真实表结构中动态提取；无 schema 时使用内置演示模板。
 */
import {
  MOCK_MARKETING_DATA,
  MOCK_INVENTORY_DATA,
} from './src/data/sampleDatasets';
import { pickFallbackAxes, extractEnumValues } from './server/schemaGuidance';

/** 基于真实 Schema 动态生成降级结果：维度/指标取自当前数据源的表结构 */
function buildSchemaAwareFallback(query: string, schema: any[]) {
  const axes = pickFallbackAxes(query, schema);
  if (!axes || !axes.dimension || axes.metrics.length === 0) return null;

  const { table, dimension, metrics } = axes;
  const dimName = dimension.name;
  const metricNames = metrics.map((m) => m.name);
  const metricLabel = (m: any) => m.description?.split(/[(（]/)[0]?.trim() || m.name;

  // 维度取值：日期列生成近 6 个月；类别列优先用 description 枚举，否则用占位值
  let dimValues: string[];
  if (dimension.type === 'date') {
    const now = new Date();
    dimValues = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  } else {
    const enums = extractEnumValues(dimension.description);
    dimValues = enums.length >= 3 ? enums : Array.from({ length: 5 }, (_, i) => `${dimName}_${i + 1}`);
  }

  // 确定性伪随机数值（基于列名 hash，保证多次调用结果一致）
  const hashNum = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
  const data = dimValues.map((v, i) => {
    const row: Record<string, any> = { [dimName]: v };
    for (const m of metricNames) {
      row[m] = 800 + ((hashNum(m) * (i + 3) * (i + 1)) % 4200);
    }
    return row;
  });

  const mainMetric = metrics[0];
  const secondMetric = metrics[1];
  const aggCols = metricNames.map((m) => `SUM(${m}) AS ${m}`).join(', ');
  const tableLabel = table.displayName || table.name;

  const kpiMetrics = metrics.slice(0, 3).map((m, i) => ({
    label: `总${metricLabel(m)}`,
    value: data.reduce((acc, r) => acc + r[m.name], 0).toLocaleString('zh-CN'),
    change: [12.4, -3.8, 6.1][i] ?? 5.0,
    trend: (i === 1 ? 'down' : 'up') as 'up' | 'down',
    subtext: `基于 ${tableLabel} 的演示统计`,
  }));

  return {
    generatedSQL: `SELECT ${dimName}, ${aggCols} FROM ${table.name} GROUP BY ${dimName} ORDER BY ${dimName} ASC;`,
    thoughtProcess: [
      `意图识别：围绕「${tableLabel}」分析用户问题`,
      `维度选择：按 ${dimName}（${dimension.description || '维度列'}）分组`,
      `指标计算：${metricNames.map((m) => `SUM(${m})`).join('、')}`,
    ],
    aiExplanation: `（离线演示数据）按 ${dimName} 维度对 ${tableLabel} 的 ${metricLabel(mainMetric)} 进行了聚合分析，${dimValues[dimValues.length - 1]} 的指标表现处于样本区间高位。接入 AI 引擎后将基于真实数据给出精确结论。`,
    keyInsights: [
      `${dimValues[dimValues.length - 1]} 的 ${metricLabel(mainMetric)} 为样本中最高值。`,
      `${metricLabel(mainMetric)} 在各 ${dimName} 间波动明显，建议结合业务背景进一步下钻。`,
      secondMetric ? `${metricLabel(secondMetric)} 与 ${metricLabel(mainMetric)} 走势基本一致，两者可能存在联动。` : `建议补充更多指标列以获得更全面的视角。`,
    ],
    chartConfig: {
      type: dimension.type === 'date' ? 'area' : 'bar',
      title: `${tableLabel}：按 ${dimName} 的 ${metricLabel(mainMetric)} 分析`,
      xAxisKey: dimName,
      yAxisKeys: metricNames,
      stacked: false,
      description: `维度 ${dimName} × 指标 ${metricNames.join('/')}`,
    },
    data,
    kpiMetrics,
    suggestedQuestions: [
      `按其他维度细分 ${tableLabel} 的 ${metricLabel(mainMetric)}`,
      `对比不同 ${dimName} 下 ${metricLabel(mainMetric)} 的占比结构`,
      `找出 ${metricLabel(mainMetric)} 异常的 ${dimName} 取值`,
    ],
  };
}

export function generateFallbackQueryResult(query: string, schema?: any[]) {
  if (Array.isArray(schema) && schema.length > 0) {
    const dynamic = buildSchemaAwareFallback(query, schema);
    if (dynamic) return dynamic;
  }
  const isMarketing = query.includes('营销') || query.includes('广告') || query.includes('ROI') || query.includes('点击');
  const isInventory = query.includes('库存') || query.includes('周转') || query.includes('预警') || query.includes('SKU');

  if (isMarketing) {
    return {
      generatedSQL: `SELECT campaign, channel, cost, clicks, leads, roi FROM marketing_funnel ORDER BY roi DESC;`,
      thoughtProcess: [
        '识别意图：评估全渠道营销投放ROI与转化效果',
        '维度匹配：广告渠道 (channel), 活动 (campaign)',
        '指标计算：ROI, 线索获取成本 (CPL)',
        '结果排序：按ROI倒序排列',
      ],
      aiExplanation: '在所有投放渠道中，行业垂直媒体与搜索引擎竞价表现最为突出，ROI分别达到5.20与4.12。信息流广告虽然曝光量巨大（1200万次），但转化率较低。',
      keyInsights: [
        '行业垂直媒体渠道ROI达 5.20，为最高效益转化渠道。',
        '618年中狂欢节消耗了48万元预算，带来了2.28万潜在线索。',
        '视频内容投流ROI仅为2.15，建议优化素材文案与受众定向。',
      ],
      chartConfig: {
        type: 'bar',
        title: '各营销渠道投放成本与ROI对比分析',
        xAxisKey: 'channel',
        yAxisKeys: ['roi', 'cost'],
        stacked: false,
        description: '展示各渠道的投资回报率(ROI)与资金投入对比',
      },
      data: MOCK_MARKETING_DATA,
      kpiMetrics: [
        { label: '总营销费用', value: '¥1.38M', change: -5.2, trend: 'up', subtext: '较上期预算节省5.2%' },
        { label: '平均广告ROI', value: '3.74', change: 12.8, trend: 'up', subtext: '行业前15%水平' },
        { label: '线索获取总量', value: '54,400', change: 24.1, trend: 'up', subtext: '有效CPL降低18%' },
      ],
      suggestedQuestions: [
        '如何优化视频投流渠道的线索转化率？',
        '按月份对比近3个季度的营销ROI变化趋势',
        '计算各活动线索的单客获取成本(CPL)',
      ],
    };
  }

  if (isInventory) {
    return {
      generatedSQL: `SELECT product_sku, product_name, stock_qty, safety_stock, turnover_days FROM product_inventory WHERE stock_qty < safety_stock;`,
      thoughtProcess: [
        '识别意图：检索低于安全库存级别的SKU及其库存周转天数',
        '条件过滤：WHERE stock_qty < safety_stock',
        '风险预警分析：关联周转天数评估断货威胁',
      ],
      aiExplanation: '当前检测到2款核心硬件产品存在缺货风险。其中"AI边缘计算网关 Pro"库存仅剩320件（安全库存500件），周转天数不足14天。',
      keyInsights: [
        'AI边缘计算网关Pro与高精传感器终端已触发安全库存警报。',
        '工业级PLC控制器库存充沛（周转天数22天），处于合理健康区间。',
        '智能高精传感器周转天数长达48天，建议清理滞销呆滞库存。',
      ],
      chartConfig: {
        type: 'bar',
        title: '核心SKU实际库存与安全库存水位对比',
        xAxisKey: 'product_name',
        yAxisKeys: ['stock_qty', 'safety_stock'],
        stacked: false,
        description: '对比当前实际库存与预设安全库存线',
      },
      data: MOCK_INVENTORY_DATA,
      kpiMetrics: [
        { label: '在库SKU总数', value: '680 款', change: 0, trend: 'neutral', subtext: '多仓联动监控中' },
        { label: '预警缺货SKU', value: '2 款', change: -50, trend: 'up', subtext: '已自动生成补货单' },
        { label: '平均周转天数', value: '29.6 天', change: -4.2, trend: 'up', subtext: '供应链效率提升' },
      ],
      suggestedQuestions: [
        '生成华东1号仓的补货计划清单',
        '分析周转天数超过45天的滞销商品名单',
        '评估云服务虚拟仓的容量利用率',
      ],
    };
  }

  // Default: Sales Trend Analysis
  return {
    generatedSQL: `SELECT date, SUM(revenue) AS revenue, SUM(profit) AS profit, SUM(orders) AS orders FROM sales_performance GROUP BY date ORDER BY date ASC;`,
    thoughtProcess: [
      '意图解析：分析近半年核心业务销售额与利润变化趋势',
      '时间聚合：按月份 (date) 进行数据 Group By',
      '指标汇总：Sum(revenue), Sum(profit), Sum(orders)',
      '趋势平滑：构建月度同比/环比增长曲线',
    ],
    aiExplanation: '2026年上半年全渠道销售表现出强劲增长态势。6月单月总营收达到 862 万元，创历史新高，其中华北地区企业直供渠道贡献最为显著。',
    keyInsights: [
      '月度营收连增6个月，6月营收较1月增长115.5%。',
      '净利润率稳定保持在 35%-42% 区间，折扣率控制良好（均值 8.3%）。',
      '线上电商渠道贡献了约45%的订单总量，客户粘性持续增强。',
    ],
    chartConfig: {
      type: 'area',
      title: '2026上半年月度销售额与净利润增长趋势',
      xAxisKey: 'date',
      yAxisKeys: ['revenue', 'profit'],
      stacked: false,
      description: '展现月度营收与净利润的双轴平滑趋势曲线',
    },
    data: [
      { date: '2026-01', revenue: 4500000, profit: 1620000, orders: 5450 },
      { date: '2026-02', revenue: 5150000, profit: 1850000, orders: 6410 },
      { date: '2026-03', revenue: 6080000, profit: 2220000, orders: 7220 },
      { date: '2026-04', revenue: 6730000, profit: 2520000, orders: 7880 },
      { date: '2026-05', revenue: 7490000, profit: 2840000, orders: 8690 },
      { date: '2026-06', revenue: 8620000, profit: 3240000, orders: 9810 },
    ],
    kpiMetrics: [
      { label: '上半年累计营收', value: '¥38.57M', change: 32.4, trend: 'up', subtext: '超额完成半年度目标的112%' },
      { label: '平均订单单价', value: '¥848', change: 8.5, trend: 'up', subtext: '客单价连续3个季度上涨' },
      { label: '综合毛利率', value: '37.1%', change: 2.3, trend: 'up', subtext: '高利润软件类目占比提升' },
    ],
    suggestedQuestions: [
      '按华东、华南、华北等大区对比上半年利润贡献',
      '找出各产品类目的折扣率与销售额散点关系',
      '预测下季度各渠道的销售增长趋势',
    ],
  };
}

export function getFallbackExecutiveReport(templateType: string, schema?: any[]) {
  // 有真实 Schema 时，报告的 KPI 与图表指标/维度也从实际表结构动态提取
  if (Array.isArray(schema) && schema.length > 0) {
    const tables = schema.filter((t) => Array.isArray(t.columns) && t.columns.length > 0).slice(0, 3);
    if (tables.length > 0) {
      const chartBlocks = tables.map((t) => {
        const axes = pickFallbackAxes(t.displayName || t.name, [t]);
        if (!axes || !axes.dimension || axes.metrics.length === 0) return null;
        const dimName = axes.dimension.name;
        const metricNames = axes.metrics.map((m) => m.name);
        const enums = axes.dimension.type === 'date'
          ? Array.from({ length: 6 }, (_, i) => {
              const d = new Date();
              d.setMonth(d.getMonth() - (5 - i));
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            })
          : (() => {
              const e = extractEnumValues(axes.dimension!.description);
              return e.length >= 3 ? e : Array.from({ length: 5 }, (_, i) => `${dimName}_${i + 1}`);
            })();
        const hashNum = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
        return {
          title: `${t.displayName || t.name}：${dimName} 维度分析`,
          chartConfig: {
            type: (axes.dimension.type === 'date' ? 'line' : 'bar') as 'line' | 'bar',
            title: `${t.displayName || t.name} ${dimName} 分析`,
            xAxisKey: dimName,
            yAxisKeys: metricNames,
          },
          data: enums.map((v, i) => {
            const row: Record<string, any> = { [dimName]: v };
            for (const m of metricNames) row[m] = 500 + ((hashNum(m) * (i + 2)) % 3600);
            return row;
          }),
          commentary: `（离线演示数据）该图表按 ${dimName} 聚合了 ${metricNames.join('、')}，接入 AI 引擎后将生成真实解读。`,
        };
      }).filter(Boolean) as any[];

      if (chartBlocks.length > 0) {
        const firstMetrics = (tables[0].columns as any[]).filter((c) => !c.isPrimaryKey && (c.isMetric ?? c.type === 'number')).slice(0, 4);
        return {
          title: `${new Date().getFullYear()}年${templateType || '经营'}决策报告`,
          summary: `（离线演示数据）本报告基于当前数据源 ${tables.map((t) => t.displayName || t.name).join('、')} 的真实表结构生成演示分析，KPI 与图表的指标维度均取自实际 Schema。接入 AI 引擎后将输出真实归因结论。`,
          createdAt: new Date().toISOString().split('T')[0],
          insights: tables.slice(0, 4).map((t, i) => ({
            title: `${t.displayName || t.name} 数据概览`,
            type: (['info', 'positive', 'warning', 'info'] as const)[i] || 'info',
            content: `该表包含 ${(t.columns || []).length} 个字段，可作为${templateType || '经营'}分析的数据基础。`,
            actionItem: '接入 AI 引擎后生成针对性建议。',
          })),
          kpiList: firstMetrics.map((c: any, i: number) => ({
            label: c.description?.split(/[(（]/)[0]?.trim() || c.name,
            value: (1000 + i * 765).toLocaleString('zh-CN'),
            change: ['+5.2%', '-1.8%', '+9.4%', '+0.6%'][i] || '+0%',
            status: (i === 1 ? 'bad' : 'good') as 'good' | 'bad',
          })),
          charts: chartBlocks,
        };
      }
    }
  }
  return {
    title: `2026年企业数字化运营与 ${templateType || '商业增长'} 决策报告`,
    summary: '本报告基于企业多维度数据接入与AI归因分析，对营收结构、营销投放效能及供应链健康度进行了系统性梳理。数据显示企业整体业绩保持高速增长，但部分区域的客单价与滞销库存仍有优化空间。',
    createdAt: new Date().toISOString().split('T')[0],
    insights: [
      {
        title: '高利润软件与云服务业务加速释放',
        type: 'positive',
        content: '企业软件与云服务类目在过去两季度营收占比提升至 48%，拉动整体毛利率上涨 2.3 个百分点。',
        actionItem: '加大B2B云端解决方案的销售人员激励与渠道跟进力度。',
      },
      {
        title: '华南线下渠道客单价呈现小幅下滑',
        type: 'warning',
        content: '华南线下门店客单价环比下降 4.1%，且平均折扣率由 9.5 降至 8.8。',
        actionItem: '针对华南区域推出高价值硬件组合套餐以提升连带率。',
      },
      {
        title: '垂直媒体投放ROI显著高于大盘',
        type: 'positive',
        content: '行业垂直媒体广告ROI达 5.20，而泛社交信息流ROI仅 2.15。',
        actionItem: '建议下季度将信息流20%的预算调配至高转化垂直媒体。',
      },
      {
        title: '硬件类目断货与呆滞双重预警',
        type: 'critical',
        content: 'AI边缘计算网关Pro库存偏低，而高精传感器终端周转天数达48天。',
        actionItem: '启动紧急补货机制，同时对长周转传感器执行促销清仓。',
      },
    ],
    kpiList: [
      { label: '全渠道总营收', value: '¥38.57M', change: '+32.4%', status: 'good' },
      { label: '综合净利润率', value: '37.1%', change: '+2.3%', status: 'good' },
      { label: '营销平均ROI', value: '3.74', change: '+12.8%', status: 'good' },
      { label: '库存周转天数', value: '29.6天', change: '-4.2天', status: 'good' },
    ],
    charts: [
      {
        title: '2026上半年月度销售额与净利润走势',
        chartConfig: {
          type: 'line',
          title: '月度营收与利润走势',
          xAxisKey: 'date',
          yAxisKeys: ['revenue', 'profit'],
        },
        data: [
          { date: '1月', revenue: 450, profit: 162 },
          { date: '2月', revenue: 515, profit: 185 },
          { date: '3月', revenue: 608, profit: 222 },
          { date: '4月', revenue: 673, profit: 252 },
          { date: '5月', revenue: 749, profit: 284 },
          { date: '6月', revenue: 862, profit: 324 },
        ],
        commentary: '营收曲线呈现连续上扬态势，6月受年中促销驱动冲至高位。',
      },
      {
        title: '营销投放渠道成本与收益分布',
        chartConfig: {
          type: 'bar',
          title: '渠道投放成本与ROI',
          xAxisKey: 'channel',
          yAxisKeys: ['roi'],
        },
        data: [
          { channel: '信息流广告', roi: 3.85 },
          { channel: '搜索引擎竞价', roi: 4.12 },
          { channel: '社媒精准种草', roi: 3.42 },
          { channel: '行业垂直媒体', roi: 5.20 },
          { channel: '视频内容投流', roi: 2.15 },
        ],
        commentary: '垂直媒体渠道效率最优，后续投放策略应向高ROI渠道倾斜。',
      },
    ],
  };
}
