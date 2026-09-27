#!/usr/bin/env node
/**
 * 数据资源库规则迁移脚本（v0.9.73）
 *
 * 将数据资源库（ds_1786620486498）的硬编码领域资产迁移为配置驱动：
 *   1. 四红线 R1-R4 → iron_rules 表 4 条 ACTIVE 铁律（与 kb_002《四红线规则与最佳实践》一致）
 *   2. 异常扫描能力配置 → data_sources.anomaly_capabilities_json（时序重算/分类检测/口径校验/领域阈值）
 *   3. 领域业务阈值 → data_sources.anomaly_thresholds_json（长龄化率 30/40、逾期金额分级）
 *
 * 幂等性：铁律按 data_source_id + title 查重跳过；能力/阈值配置为整字段覆盖写（重复执行结果一致）。
 * 用法：npm run migrate:data-resource-rules
 * 退出码：0 成功 / 1 数据源不存在（请先运行 npm run init:data-resource）/ 2 数据库不可达
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { DATA_RESOURCE_DS_ID } from '../server/seedDataResources';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

/** 四红线铁律（内容直接注入问数/报表阶段一 prompt，措辞与 kb_002 知识条目对齐） */
const RED_LINE_RULES: { title: string; content: string }[] = [
  {
    title: 'R1-最新快照期锁定',
    content:
      '查询 fct_jc_main_biz_stat / fct_jc_financial_stat 的「最新」数据时必须使用 MAX(BBRQ)（财务表 MAX(SJRQ)）子查询锁定最新快照期，禁止跨期累加；禁用日期范围（>= / BETWEEN）代替 MAX 锁定（会包含多期快照导致重复累计）。',
  },
  {
    title: 'R2-核算版过滤',
    content:
      "所有涉及 fct_jc_main_biz_stat / fct_jc_financial_stat 的统计查询必须添加 WHERE BB = '1'（核算版），禁止将分成版（BB != '1'）数据纳入汇总，否则机构金额之和将大于实际总额、排名失真。",
  },
  {
    title: 'R3-项目数去重计数',
    content:
      '统计项目数必须使用 COUNT(DISTINCT XMBH)，禁止使用 COUNT(*) / COUNT(XMBH)，避免同一项目的多笔投放/跨机构联合记录重复计数。',
  },
  {
    title: 'R4-财务指标走财务表',
    content:
      '投资收益类指标（DNTZSY 当年投资收益 / LZNZSY 累计投资收益等）必须查询财务宽表 fct_jc_financial_stat，禁止从业务宽表 fct_jc_main_biz_stat 查询收益数据（业务表金额为投放口径，非收益口径）。',
  },
];

/** 异常扫描能力配置（与 server/datasource/autoConfig.ts 的 AnomalyCapabilities 结构一致） */
const CAPABILITIES = {
  timeSeriesRecalc: { enabled: true, dateColumn: 'BBRQ', maxPeriods: 12 },
  categoricalDetection: { enabled: true, rankChangeThreshold: 3, shareShiftThreshold: 10 },
  caliberCheck: { enabled: true, rules: { snapshotLock: true, versionFilter: true, distinctCount: true } },
  domainThresholds: { enabled: true, thresholds: ['长龄化率', '逾期金额'] },
};

/**
 * 领域业务阈值（与异常扫描引擎 DomainThresholdsConfig 对齐）：
 * - warnAbove/criticalAbove：单向阈值（高于则关注/严重）；
 * - levels：分级制（按 maxExclusive 升序，最后一级无上限）。
 */
const DOMAIN_THRESHOLDS = {
  timeSeries: { momPercent: 20, yoyPercent: 30 },
  metrics: {
    长龄化率: { unit: '%', warnAbove: 30, criticalAbove: 40 },
    逾期金额: {
      unit: '万元',
      levels: [
        { maxExclusive: 100, label: '一般', level: 'low' },
        { maxExclusive: 500, label: '较大', level: 'medium' },
        { label: '重大', level: 'high' },
      ],
    },
  },
};

async function main(): Promise<number> {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'smart_analytics',
    connectionLimit: 2,
  });

  try {
    // 0. 校验数据资源库数据源存在（不存在则先初始化，避免产生孤儿规则）
    const [dsRows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT id, name FROM data_sources WHERE id = ?',
      [DATA_RESOURCE_DS_ID]
    );
    if (dsRows.length === 0) {
      console.error(`[migrate] 数据资源库数据源不存在（${DATA_RESOURCE_DS_ID}），请先运行 npm run init:data-resource`);
      return 1;
    }
    const dsName = String(dsRows[0].name || DATA_RESOURCE_DS_ID);
    console.log(`[migrate] 目标数据源：${dsName}（${DATA_RESOURCE_DS_ID}）`);

    // 1. 四红线 → iron_rules（幂等：同标题已存在则跳过，不覆盖管理员后续手工修订）
    let inserted = 0;
    let skipped = 0;
    for (const rule of RED_LINE_RULES) {
      const [exist] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT id FROM iron_rules WHERE data_source_id = ? AND title = ? LIMIT 1',
        [DATA_RESOURCE_DS_ID, rule.title]
      );
      if (exist.length > 0) {
        skipped++;
        continue;
      }
      await pool.query(
        "INSERT INTO iron_rules (data_source_id, title, content, status, created_by) VALUES (?, ?, ?, 'ACTIVE', 'system-migration')",
        [DATA_RESOURCE_DS_ID, rule.title, rule.content]
      );
      inserted++;
    }
    console.log(`[migrate] 铁律迁移：新增 ${inserted} 条，跳过已存在 ${skipped} 条（共 ${RED_LINE_RULES.length} 条四红线）`);

    // 2. 能力配置 + 领域阈值写入数据源（整字段覆盖写，重复执行结果一致）
    await pool.query(
      'UPDATE data_sources SET anomaly_capabilities_json = ?, anomaly_thresholds_json = ? WHERE id = ?',
      [JSON.stringify(CAPABILITIES), JSON.stringify(DOMAIN_THRESHOLDS), DATA_RESOURCE_DS_ID]
    );
    console.log('[migrate] 能力配置已写入 anomaly_capabilities_json（时序重算/分类检测/口径校验/领域阈值）');
    console.log('[migrate] 领域阈值已写入 anomaly_thresholds_json（长龄化率 30%/40%，逾期金额三级）');

    console.log('[migrate] ✅ 迁移完成');
    return 0;
  } catch (err) {
    console.error(`[migrate] 数据库操作失败：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then((code) => {
  process.exitCode = code;
});
