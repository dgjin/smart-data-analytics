import { SavedReport, AnomalyItem } from '../types/analytics';

/**
 * AI & Statistical Anomaly Detection Engine for Visual Reports
 * Utilizes Z-Score (adaptive threshold), Percentage Volatility, and Threshold Breaches
 */

const newAnomalyId = (prefix: string) =>
  `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function scanReportForAnomalies(report: SavedReport): SavedReport {
  const anomalies: AnomalyItem[] = [];

  // 1. Scan KPIs for Anomalies
  const updatedKpiList = report.kpiList.map((kpi, idx) => {
    const rawChangeNum = parseFloat(kpi.change.replace(/[^0-9.-]/g, ''));
    let isAnomaly = false;
    let anomalyNote = '';

    // Check for extreme spike or drop
    if (!isNaN(rawChangeNum)) {
      if (rawChangeNum >= 25) {
        isAnomaly = true;
        anomalyNote = `⚡ 异常激发突增: 增长幅度高出预期阈值 (+${rawChangeNum}%)`;
        anomalies.push({
          id: newAnomalyId(`anomaly-kpi-${idx}`),
          metricLabel: kpi.label,
          severity: rawChangeNum >= 40 ? 'high' : 'medium',
          type: 'spike',
          actualValue: kpi.value,
          expectedValue: '正常增长 5%~15%',
          deviationPercent: rawChangeNum,
          reasoning: `KPI【${kpi.label}】监测到指标快速拉升 (+${rawChangeNum}%)，建议核查是否有营销投流冲量或偶发性大单采购。`,
          location: 'kpi',
        });
      } else if (rawChangeNum <= -10) {
        isAnomaly = true;
        anomalyNote = `⚠️ 陡降预警: 指标下滑超预警红线 (${rawChangeNum}%)`;
        anomalies.push({
          id: newAnomalyId(`anomaly-kpi-${idx}`),
          metricLabel: kpi.label,
          severity: 'high',
          type: 'drop',
          actualValue: kpi.value,
          expectedValue: '稳定波动 ±5%',
          deviationPercent: rawChangeNum,
          reasoning: `KPI【${kpi.label}】录得明显缩减 (${rawChangeNum}%)，可能存在转化流失、供应链断货或大客户退单风险。`,
          location: 'kpi',
        });
      }
    }

    if (kpi.status === 'bad' && !isAnomaly) {
      isAnomaly = true;
      anomalyNote = '🚨 关键指标处于不健康区间';
      anomalies.push({
        id: newAnomalyId(`anomaly-kpi-bad-${idx}`),
        metricLabel: kpi.label,
        severity: 'medium',
        type: 'threshold',
        actualValue: kpi.value,
        expectedValue: '健康控制水平',
        deviationPercent: -15,
        reasoning: `【${kpi.label}】触发业务风控阈值。`,
        location: 'kpi',
      });
    }

    return {
      ...kpi,
      isAnomaly,
      anomalyNote: anomalyNote || kpi.anomalyNote,
    };
  });

  // 2. Scan Chart Datasets for Time-Series / Categorical Anomalies
  const updatedCharts = report.charts.map((chartBlock, chartIdx) => {
    const chartAnomalies: AnomalyItem[] = [];
    const data = chartBlock.data;

    if (data && data.length >= 3) {
      const { xAxisKey, yAxisKeys } = chartBlock.chartConfig;

      yAxisKeys.forEach((yKey) => {
        const values = data.map((d) => Number(d[yKey]) || 0);

        // Small samples have unstable statistics — require a stronger deviation
        const zThreshold = values.length < 10 ? 2.0 : 1.4;

        // Calculate Mean & Standard Deviation
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
        const stdDev = Math.sqrt(variance);

        // Scan each data point
        data.forEach((row, rowIdx) => {
          const val = Number(row[yKey]) || 0;
          const dimVal = String(row[xAxisKey] || `节点 ${rowIdx + 1}`);

          if (stdDev > 0) {
            const zScore = (val - mean) / stdDev;
            const devPct = mean !== 0 ? Math.round(((val - mean) / mean) * 100) : 0;

            if (Math.abs(zScore) >= zThreshold) {
              const isSpike = zScore > 0;
              const severity = Math.abs(zScore) >= Math.max(2.0, zThreshold) ? 'high' : 'medium';

              const anomaly: AnomalyItem = {
                id: `anomaly-chart-${chartIdx}-${rowIdx}-${yKey}`,
                metricLabel: `${chartBlock.title} (${yKey})`,
                dimensionValue: dimVal,
                severity,
                type: isSpike ? 'spike' : 'drop',
                actualValue: val.toLocaleString(),
                expectedValue: Math.round(mean).toLocaleString(),
                deviationPercent: devPct,
                zScore: Number(zScore.toFixed(2)),
                reasoning: `数据维度【${dimVal}】在【${yKey}】上录得 ${val.toLocaleString()}，偏离历史均值 (${Math.round(mean).toLocaleString()}) 达到 ${Math.abs(zScore).toFixed(2)} 倍标准差 (Z-Score)。`,
                location: 'chart',
                chartTitle: chartBlock.title,
              };

              chartAnomalies.push(anomaly);
              anomalies.push(anomaly);
            }
          }
        });
      });
    }

    return {
      ...chartBlock,
      anomalies: chartAnomalies,
    };
  });

  return {
    ...report,
    kpiList: updatedKpiList,
    charts: updatedCharts,
    anomalies,
    anomalyScanTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}
