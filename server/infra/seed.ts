/**
 * 持久化层 - 初始种子（质量优化 Stage 3.1 四拆分之 seed.ts）：
 * 默认管理员、内置技能、预设报告模板、出厂看板组件、示例数据源、env 配置键位。
 * 全部幂等（仅表空/键不存在时写入），由 db.ts 的 initSchema 在结构就绪后调用。
 */
import mysql from 'mysql2/promise';
import { INITIAL_DATA_SOURCES } from '../seedData';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { BUILTIN_SKILLS } from '../skills';
import { DEFAULT_DASHBOARD_WIDGET_SEEDS } from '../defaultWidgets';
import { ENV_CONFIG_SEED } from './envConfigCatalog';
import { logger } from './logger';

// 默认管理员账号：随种子自 db.ts 迁入；ESM import 提升要求惰性读取环境变量
const defaultAdminUsername = () => process.env.ADMIN_USERNAME || 'admin';
const defaultAdminPassword = () => process.env.ADMIN_PASSWORD || 'admin123';

/** 初始种子（幂等；管理员/技能/模板/看板/示例数据源/env 键位） */
export async function seedInitialData(pool: mysql.Pool): Promise<void> {
  // 内置技能种子：写入系统技能库（按 skill_id 幂等跳过，管理员可继续维护）
  for (const sk of BUILTIN_SKILLS) {
    await pool.query(
      `INSERT INTO skill_library (skill_id, name, description, prompt_template, placeholders, scope, status, created_by)
       SELECT ?, ?, ?, ?, ?, 'SYSTEM', 'ACTIVE', 'system-seed'
       FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM skill_library WHERE skill_id = ?)`,
      [sk.id, sk.name, sk.description, sk.promptTemplate, JSON.stringify(sk.placeholders), sk.id]
    );
  }

  // v0.9.24 出厂内置默认看板图表（表空时幂等 seed；user_id=0/system 仅 ADMIN 可删）
  const [dwRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM dashboard_widgets');
  if (Number(dwRows[0]?.cnt) === 0) {
    for (const seed of DEFAULT_DASHBOARD_WIDGET_SEEDS) {
      await pool.query(
        'INSERT INTO dashboard_widgets (widget_id, user_id, username, widget_data, sort_order) VALUES (?, 0, ?, ?, ?)',
        [seed.widgetId, 'system', JSON.stringify(seed.widget), seed.sortOrder],
      );
    }
  }

  // v0.5.0 初始化预设报告模板（幂等插入）
  const [templateRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM report_templates WHERE is_preset = 1');
  if (Number(templateRows[0]?.cnt) === 0) {
    const presetTemplates = [
      {
        name: '综合经营分析',
        description: '投放规模与逐月趋势、业务分类结构、机构分布及长龄/逾期资产质量的月末快照综合盘点',
        content: JSON.stringify({
          sections: [
            { title: '投放规模与趋势', prompt: '分析本年投放金额的总体规模、逐月趋势与同比变化', chartType: 'line' },
            { title: '业务分类结构', prompt: '按业务分类统计投放金额占比与分布', chartType: 'pie' },
            { title: '机构分布', prompt: '按机构统计投放金额排名与占比', chartType: 'bar' },
            { title: '资产质量', prompt: '分析长龄业务占比、逾期金额分布等风险指标', chartType: 'bar' },
          ],
        }),
      },
      {
        name: '资产质量与风险监控',
        description: '聚焦长龄业务占比与机构分布、逾期金额按业务分类分布及风险项目机构分布',
        content: JSON.stringify({
          sections: [
            { title: '长龄业务分析', prompt: '统计长龄业务占比、机构分布与趋势', chartType: 'bar' },
            { title: '逾期金额分布', prompt: '按业务分类统计逾期金额与占比', chartType: 'pie' },
            { title: '风险项目分布', prompt: '按机构统计风险项目数量与金额', chartType: 'bar' },
          ],
        }),
      },
      {
        name: '投资收益与财务分析',
        description: '基于财务宽表（核算版），按科目一级分类与月度分析投资收益、利息收入等财务效能指标',
        content: JSON.stringify({
          sections: [
            { title: '投资收益分析', prompt: '按科目分类统计投资收益规模与趋势', chartType: 'line' },
            { title: '利息收入分析', prompt: '统计利息收入的月度变化与构成', chartType: 'bar' },
            { title: '财务效能指标', prompt: '计算并分析关键财务效能指标', chartType: 'kpi' },
          ],
        }),
      },
      {
        name: '企业战略决策简报',
        description: '面向CEO/CFO的高管摘要，包含不良资产业务归因诊断、风险预警与战略落地方案',
        content: JSON.stringify({
          sections: [
            { title: '高管摘要', prompt: '生成一段话高管摘要，概括核心业务表现与关键发现', chartType: 'text' },
            { title: '业务归因诊断', prompt: '分析业务表现的根本原因与驱动因素', chartType: 'text' },
            { title: '风险预警', prompt: '识别潜在风险点并提供预警建议', chartType: 'text' },
            { title: '战略落地方案', prompt: '提出可操作的战略落地建议与行动项', chartType: 'text' },
          ],
        }),
      },
    ];
    for (const tpl of presetTemplates) {
      await pool.query(
        'INSERT INTO report_templates (name, description, template_content, is_preset, created_by) VALUES (?, ?, ?, 1, ?)',
        [tpl.name, tpl.description, tpl.content, 'system']
      );
    }
  }

  // 4. Seed default admin when users table is empty（首登强制改密）
  const [userRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM users');
  if (Number(userRows[0]?.cnt) === 0) {
    await pool.query(
      'INSERT INTO users (username, password_hash, display_name, role, must_change_password) VALUES (?, ?, ?, ?, 1)',
      [defaultAdminUsername(), hashPassword(defaultAdminPassword()), '系统管理员', 'ADMIN']
    );
    logger.info(`[DB] Seeded default admin account: ${defaultAdminUsername()} (首次登录将强制修改初始密码)`);
  }

  // P0 安全告警：管理员仍在使用默认密码时每次启动提醒；仅对从未登录过的账号置强制改密标记
  // （首登前置位无副作用；已登录过的账号不反复锁死，避免打断开发/评测等程序化流程）
  const [adminRows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT id, password_hash, last_login_at FROM users WHERE username = ? LIMIT 1',
    [defaultAdminUsername()]
  );
  if (adminRows[0] && verifyPassword(defaultAdminPassword(), String(adminRows[0].password_hash))) {
    if (adminRows[0].last_login_at == null) {
      await pool.query('UPDATE users SET must_change_password = 1 WHERE id = ?', [adminRows[0].id]);
      logger.warn('[Security] ⚠️ 管理员账号使用默认密码且从未登录，首次登录将强制修改密码！');
    } else {
      logger.warn('[Security] ⚠️ 管理员账号仍在使用默认密码，请尽快修改！');
    }
  }

  // v0.9.66 组织架构树：总部根节点（系统内置唯一，幂等补种；机构挂在总部下）
  const [orgRows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS cnt FROM org_units WHERE level = 'HQ'");
  if (Number(orgRows[0]?.cnt) === 0) {
    await pool.query(
      "INSERT INTO org_units (parent_id, level, name, data_code, sort_order, created_by) VALUES (NULL, 'HQ', '总部', '', 0, 'system-seed')"
    );
    logger.info('[DB] Seeded 组织架构根节点：总部');
  }

  // 5. Seed demo data sources when table is empty
  const [dsRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM data_sources');
  if (Number(dsRows[0]?.cnt) === 0) {
    for (const ds of INITIAL_DATA_SOURCES) {
      await pool.query(
        'INSERT INTO data_sources (id, name, type, config_json, schema_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          ds.id,
          ds.name,
          ds.type,
          JSON.stringify(ds.config || {}),
          JSON.stringify(ds.tables || []),
          ds.status,
          'system-seed',
        ]
      );
    }
    logger.info(`[DB] Seeded ${INITIAL_DATA_SOURCES.length} demo data sources`);
  }

  // 5b. v0.9.61 环境配置在线化：补种标准键位（幂等；值留空=跟随 .env.local，已存在行不覆盖）。
  // 面板保存非空值后由 envConfigSync 合并进 process.env——面板优先于 .env.local 且重启保持。
  let seededEnvKeys = 0;
  for (const item of ENV_CONFIG_SEED) {
    const [res] = await pool.query<mysql.ResultSetHeader>(
      "INSERT IGNORE INTO env_config (`key`, `value`, category, description, is_sensitive) VALUES (?, '', ?, ?, ?)",
      [item.key, item.category, item.description, item.sensitive ? 1 : 0]
    );
    seededEnvKeys += res.affectedRows;
  }
  if (seededEnvKeys > 0) logger.info(`[DB] Seeded ${seededEnvKeys} env_config keys（空值=跟随 .env.local）`);

}
