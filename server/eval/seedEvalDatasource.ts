/**
 * P0 评测数据源种子脚本：一键重建可复现的 NL2SQL 评测环境（解决评测集数据源失联问题）。
 *
 * 职责：
 * 1. 建库 smart_eval_crm + 5 张表（clients/visits/users/departments/roles）+ 确定性数据
 *    （纯模运算分配，无随机数：任何环境重建结果完全一致，golden SQL 结果确定）
 * 2. 注册两个数据源（幂等 upsert）：
 *    - ds_eval_crm      全量数据源（主评测集默认源）
 *    - ds_eval_crm_dept1 业务一部行级过滤源（scope.rowFilters 对 clients/visits/users
 *      同时注入部门谓词，permission 类用例专用：测 AST 行过滤注入的端到端正确性；
 *      双表一致过滤防止单表过滤被另一表的裸查询绕过）
 * 3. 数据自检：Top-N 用例依赖的唯一性约束（拜访人/行业/月度/客户拜访次数唯一最大），
 *    违反即抛错（防手改数据后评测用例产生歧义）
 * 4. golden SQL 执行验证：逐条执行评测集全部 result 类 golden SQL，可执行性不通过即退出码非零
 *    （落实 docs/评测集标注规范.md 第五节「执行验证」）
 *
 * 用法：npm run eval:seed
 * 环境变量：复用 MYSQL_*（评测库与应用库同实例）；EVAL_CRM_DB 可覆盖库名（默认 smart_eval_crm）
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvalCases } from './evalRunner';
import { encryptConfigPassword } from '../infra/secretsCrypto';
import type { TableSchema } from '../../src/types/analytics';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: join(ROOT, '.env.local') });
dotenv.config({ path: join(ROOT, '.env') });

export const EVAL_CRM_DS_ID = 'ds_eval_crm';
export const EVAL_CRM_DEPT1_DS_ID = 'ds_eval_crm_dept1';
export const EVAL_CRM_DB = process.env.EVAL_CRM_DB || 'smart_eval_crm';

// ============ 取值域（覆盖评测集全部用例引用的维度值） ============
const INDUSTRIES_HEAD = '金融业';
const INDUSTRIES_TAIL = ['制造业', '建筑业', '批发零售业', '信息软件业', '科学研究业'];
const REGIONS = ['华东', '华北', '华南', '西南', '安徽合肥']; // '安徽合肥' 供 LIKE '%合肥%' 用例
const CLIENT_TYPES = ['金融机构', '产业客户', '地方政府', '事业单位', '国有企业'];
const LIST_CATEGORIES = ['央国企客户', '民营中小企业客户', '上市公司客户', '政府机构客户'];
const TEAMS = ['一部一团队', '一部二团队', '二部三团队', '三部一团队'];
const VISIT_TYPES = ['线下拜访', '电话沟通', '线上会议', '客户到访'];
const SENTIMENTS = ['积极', '消极', '中性'];
const USER_NAMES = ['王卫东', '李采诗', '张明远', '陈国华', '刘思颖', '赵建华', '孙丽娟', '周文博', '吴静怡', '郑海涛', '冯雅琪', '钱进'];
const DEPARTMENT_NAMES = ['业务一部', '业务二部', '业务三部'];
const ROLE_NAMES = ['管理员', '分析师', '只读'];

/** 业务一部（departmentId=1）行级过滤：谓词与自检共用同一来源，保证口径一致 */
const DEPT1_USER_IDS = [1, 4, 7, 10];
const DEPT1_OWNER_NAMES = DEPT1_USER_IDS.map((i) => USER_NAMES[i - 1]);
const DEPT1_CLIENTS_PRED = `ownerId IN (${DEPT1_USER_IDS.join(', ')})`;
const DEPT1_VISITS_PRED = `ownerName IN (${DEPT1_OWNER_NAMES.map((n) => `'${n}'`).join(', ')})`;

const CLIENT_COUNT = 60;
const USER_COUNT = 12;

/** 客户拜访次数配额：Top1-5 唯一递减（30/25/21/19/18），6-52 号 4~8 次，53-60 号 0 次（供「无拜访客户」用例） */
function clientQuota(i: number): number {
  if (i <= 5) return [30, 25, 21, 19, 18][i - 1];
  if (i <= 52) return 4 + (i % 5);
  return 0;
}

/** 全局拜访序号 → 年月（分段总量 45/70/85/110/84，互异且最大值唯一，供 Top-N 月度用例） */
function monthOf(v: number): string {
  if (v <= 45) return '2026-04';
  if (v <= 115) return '2026-05';
  if (v <= 200) return '2026-06';
  if (v <= 310) return '2026-07';
  return '2026-08';
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

// ============ 确定性数据构造（i 均为 1 起） ============
function buildClients(): any[] {
  const rows: any[] = [];
  for (let i = 1; i <= CLIENT_COUNT; i++) {
    rows.push({
      id: i,
      name: `客户${pad(i, 3)}`,
      // 1-12 号为金融业（12 个，唯一最大行业）；其余轮转 5 行业（10/10/10/9/9）
      industry: i <= 12 ? INDUSTRIES_HEAD : INDUSTRIES_TAIL[(i - 13) % 5],
      region: REGIONS[(i - 1) % 5],
      clientType: CLIENT_TYPES[(i - 1) % 5],
      listCategory: LIST_CATEGORIES[(i - 1) % 4],
      isKeyAccount: i % 3 === 0 ? 1 : 0,
      team: i % 7 === 0 ? '' : TEAMS[(i - 1) % 4], // 7 的倍数留空（空值陷阱用例）
      ownerId: ((i - 1) % USER_COUNT) + 1,
    });
  }
  return rows;
}

function buildVisits(clients: any[]): any[] {
  const rows: any[] = [];
  let v = 0;
  for (const c of clients) {
    for (let k = 0; k < clientQuota(c.id); k++) {
      v += 1;
      const ym = monthOf(v);
      rows.push({
        id: v,
        clientId: c.id,
        type: VISIT_TYPES[v % 4],
        sentiment: SENTIMENTS[v % 3],
        date: `${ym}-${pad((v % 28) + 1)} 10:00:00`,
        ownerName: USER_NAMES[(c.id - 1) % USER_COUNT],
      });
    }
  }
  return rows;
}

function buildUsers(): any[] {
  const rows: any[] = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    rows.push({
      id: i,
      name: USER_NAMES[i - 1],
      status: i === 10 || i === 12 ? 'disabled' : 'active',
      departmentId: ((i - 1) % 3) + 1,
      roleId: ((i - 1) % 3) + 1,
    });
  }
  return rows;
}

// ============ Schema（问数 prompt 注入用，列名与 golden SQL 严格一致） ============
function col(name: string, type: TableSchema['columns'][number]['type'], description: string, extra: Record<string, unknown> = {}) {
  return { name, type, description, ...extra };
}

function evalCrmSchemas(rowCounts: { clients: number; visits: number; users: number }): TableSchema[] {
  return [
    {
      id: 'clients', name: 'clients', displayName: '客户表', description: '客户主数据：行业、区域、类型、清单分类、是否重点客户、所属团队与负责人',
      rowCount: rowCounts.clients,
      columns: [
        col('id', 'number', '客户ID', { isPrimaryKey: true, isDimension: true }),
        col('name', 'string', '客户名称', { isDimension: true }),
        col('industry', 'category', '行业', { isDimension: true }),
        col('region', 'category', '区域', { isDimension: true }),
        col('clientType', 'category', '客户类型', { isDimension: true }),
        col('listCategory', 'category', '清单分类', { isDimension: true }),
        col('isKeyAccount', 'boolean', '是否重点客户（1=是，0=否）', { isDimension: true }),
        col('team', 'string', '所属团队（部分客户未登记，值为空）', { isDimension: true }),
        col('ownerId', 'number', '负责人的用户ID（关联 users.id）', { isDimension: true }),
      ],
    },
    {
      id: 'visits', name: 'visits', displayName: '拜访记录表', description: '客户拜访流水：拜访类型、情感倾向、日期（2026-04 至 2026-08）、拜访人',
      rowCount: rowCounts.visits,
      columns: [
        col('id', 'number', '拜访记录ID', { isPrimaryKey: true, isDimension: true }),
        col('clientId', 'number', '客户ID（关联 clients.id）', { isDimension: true }),
        col('type', 'category', '拜访类型（线下拜访/电话沟通/线上会议/客户到访）', { isDimension: true }),
        col('sentiment', 'category', '情感倾向（积极/消极/中性）', { isDimension: true }),
        col('date', 'date', '拜访日期时间（字符串，年月取 LEFT(`date`,7)）', { isDimension: true }),
        col('ownerName', 'string', '拜访人姓名', { isDimension: true }),
      ],
    },
    {
      id: 'users', name: 'users', displayName: '用户表', description: '系统用户：状态、所属部门、角色',
      rowCount: rowCounts.users,
      columns: [
        col('id', 'number', '用户ID', { isPrimaryKey: true, isDimension: true }),
        col('name', 'string', '用户姓名', { isDimension: true }),
        col('status', 'category', '状态（active=启用，disabled=停用）', { isDimension: true }),
        col('departmentId', 'number', '部门ID（关联 departments.id）', { isDimension: true }),
        col('roleId', 'number', '角色ID（关联 roles.id）', { isDimension: true }),
      ],
    },
    {
      id: 'departments', name: 'departments', displayName: '部门表', description: '部门字典',
      rowCount: DEPARTMENT_NAMES.length,
      columns: [
        col('id', 'number', '部门ID', { isPrimaryKey: true, isDimension: true }),
        col('name', 'string', '部门名称', { isDimension: true }),
      ],
    },
    {
      id: 'roles', name: 'roles', displayName: '角色表', description: '角色字典',
      rowCount: ROLE_NAMES.length,
      columns: [
        col('id', 'number', '角色ID', { isPrimaryKey: true, isDimension: true }),
        col('name', 'string', '角色名称', { isDimension: true }),
      ],
    },
  ];
}

// ============ 主流程 ============
async function main() {
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MYSQL_PORT || 3306);
  const user = process.env.MYSQL_USER || 'root';
  const password = process.env.MYSQL_PASSWORD || '';
  const appDb = process.env.MYSQL_DATABASE || 'smart_analytics';

  const appPool = await mysql.createConnection({ host, port, user, password, database: appDb });
  console.log(`[eval-seed] 应用库连接成功（${host}:${port}/${appDb}）`);

  // 1. 建评测库（幂等）
  await appPool.query(`CREATE DATABASE IF NOT EXISTS \`${EVAL_CRM_DB}\` DEFAULT CHARACTER SET utf8mb4`);
  console.log(`[eval-seed] 评测库就绪：${EVAL_CRM_DB}`);

  const crm = await mysql.createConnection({ host, port, user, password, database: EVAL_CRM_DB, multipleStatements: false });

  // 2. 重建表结构（DROP+CREATE 保证 schema 漂移后仍一致；评测库专用，安全）
  await crm.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['clients', 'visits', 'users', 'departments', 'roles']) {
    await crm.query(`DROP TABLE IF EXISTS \`${t}\``);
  }
  await crm.query('SET FOREIGN_KEY_CHECKS = 1');
  await crm.query(`CREATE TABLE clients (
    id INT PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    industry VARCHAR(64) NOT NULL DEFAULT '',
    region VARCHAR(64) NOT NULL DEFAULT '',
    clientType VARCHAR(64) NOT NULL DEFAULT '',
    listCategory VARCHAR(64) NOT NULL DEFAULT '',
    isKeyAccount TINYINT NOT NULL DEFAULT 0,
    team VARCHAR(64) NOT NULL DEFAULT '',
    ownerId INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await crm.query(`CREATE TABLE visits (
    id INT PRIMARY KEY,
    clientId INT NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT '',
    sentiment VARCHAR(16) NOT NULL DEFAULT '',
    \`date\` VARCHAR(32) NOT NULL,
    ownerName VARCHAR(64) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await crm.query(`CREATE TABLE users (
    id INT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    departmentId INT NOT NULL,
    roleId INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await crm.query(`CREATE TABLE departments (
    id INT PRIMARY KEY,
    name VARCHAR(64) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await crm.query(`CREATE TABLE roles (
    id INT PRIMARY KEY,
    name VARCHAR(64) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // 3. 灌入确定性数据
  const clients = buildClients();
  const visits = buildVisits(clients);
  const users = buildUsers();
  for (const [i, d] of DEPARTMENT_NAMES.entries()) {
    await crm.query('INSERT INTO departments (id, name) VALUES (?, ?)', [i + 1, d]);
  }
  for (const [i, r] of ROLE_NAMES.entries()) {
    await crm.query('INSERT INTO roles (id, name) VALUES (?, ?)', [i + 1, r]);
  }
  for (const u of users) {
    await crm.query('INSERT INTO users (id, name, status, departmentId, roleId) VALUES (?, ?, ?, ?, ?)',
      [u.id, u.name, u.status, u.departmentId, u.roleId]);
  }
  for (const c of clients) {
    await crm.query('INSERT INTO clients (id, name, industry, region, clientType, listCategory, isKeyAccount, team, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.id, c.name, c.industry, c.region, c.clientType, c.listCategory, c.isKeyAccount, c.team, c.ownerId]);
  }
  for (const v of visits) {
    await crm.query('INSERT INTO visits (id, clientId, type, sentiment, `date`, ownerName) VALUES (?, ?, ?, ?, ?, ?)',
      [v.id, v.clientId, v.type, v.sentiment, v.date, v.ownerName]);
  }
  console.log(`[eval-seed] 数据就绪：clients=${clients.length} visits=${visits.length} users=${users.length} departments=${DEPARTMENT_NAMES.length} roles=${ROLE_NAMES.length}`);

  // 4. 唯一性自检（Top-N 用例无并列的保障）
  async function topN(sql: string, n: number): Promise<any[]> {
    const [rows] = await crm.query<mysql.RowDataPacket[]>(sql);
    return rows.slice(0, n);
  }
  const ownersTop = await topN('SELECT ownerName, COUNT(*) c FROM visits GROUP BY ownerName ORDER BY c DESC, ownerName', 2);
  assert(ownersTop.length === 2 && ownersTop[0].c > ownersTop[1].c, `拜访人次数最大值须唯一（现 ${ownersTop[0]?.c} vs ${ownersTop[1]?.c}）`);
  const industryTop = await topN('SELECT industry, COUNT(*) c FROM clients GROUP BY industry ORDER BY c DESC, industry', 2);
  assert(industryTop.length === 2 && industryTop[0].c > industryTop[1].c, `行业客户数最大值须唯一（现 ${industryTop[0]?.c} vs ${industryTop[1]?.c}）`);
  const monthTop = await topN('SELECT LEFT(`date`,7) ym, COUNT(*) c FROM visits GROUP BY ym ORDER BY c DESC, ym', 2);
  assert(monthTop.length === 2 && monthTop[0].c > monthTop[1].c, `月度拜访次数最大值须唯一（现 ${monthTop[0]?.c} vs ${monthTop[1]?.c}）`);
  const clientTop = await topN('SELECT clientId, COUNT(*) c FROM visits GROUP BY clientId ORDER BY c DESC, clientId', 4);
  assert(
    clientTop.length === 4 && clientTop[0].c > clientTop[1].c && clientTop[1].c > clientTop[2].c && clientTop[2].c > clientTop[3].c,
    `客户拜访次数 Top4 须严格递减（现 ${clientTop.map((r: any) => r.c).join(' > ')}）`
  );
  const [noVisit] = await crm.query<mysql.RowDataPacket[]>('SELECT COUNT(*) c FROM clients WHERE id NOT IN (SELECT clientId FROM visits)');
  assert(noVisit[0].c === 8, `无拜访记录客户数须为 8（现 ${noVisit[0].c}）`);
  const [monthRows] = await crm.query<mysql.RowDataPacket[]>('SELECT DISTINCT LEFT(`date`,7) ym FROM visits ORDER BY ym');
  const months = monthRows.map((r) => r.ym);
  assert(
    months.length === 5 && months[0] === '2026-04' && months[4] === '2026-08',
    `拜访月份须覆盖 2026-04 至 2026-08（现 ${months.join(',')}）`
  );
  // 行级过滤域自检（permission 类 golden 口径的锚点，防数据漂移）
  const [deptClients] = await crm.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) c FROM clients WHERE ${DEPT1_CLIENTS_PRED}`);
  assert(deptClients[0].c === 20, `业务一部客户数须为 20（现 ${deptClients[0].c}）`);
  const [deptVisits] = await crm.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) c FROM visits WHERE ${DEPT1_VISITS_PRED}`);
  assert(deptVisits[0].c === 145, `业务一部拜访数须为 145（现 ${deptVisits[0].c}）`);
  const [deptNoVisit] = await crm.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) c FROM clients c WHERE c.${DEPT1_CLIENTS_PRED} AND c.id NOT IN (SELECT clientId FROM visits)`
  );
  assert(deptNoVisit[0].c === 2, `业务一部无拜访客户数须为 2（现 ${deptNoVisit[0].c}）`);
  console.log('[eval-seed] 唯一性自检通过（Top-N 用例无并列，行级过滤域口径锚点一致，golden 结果确定）');

  // 5. 注册数据源（幂等 upsert；密码加密落库）
  const config = encryptConfigPassword({ host, port, database: EVAL_CRM_DB, username: user, password });
  const schemas = evalCrmSchemas({ clients: clients.length, visits: visits.length, users: users.length });
  const schemaJson = JSON.stringify(schemas);
  // 业务一部行级过滤：clients/visits/users 三表同时注入部门谓词（双表一致过滤防裸查询绕过）
  const dept1Scope = JSON.stringify({
    tables: ['clients', 'visits', 'users', 'departments', 'roles'],
    rowFilters: {
      clients: DEPT1_CLIENTS_PRED,
      visits: DEPT1_VISITS_PRED,
      users: 'departmentId = 1',
    },
  });
  async function upsertDs(id: string, name: string, scopeJson: string | null, description: string) {
    await appPool.query(
      `INSERT INTO data_sources (id, name, type, config_json, schema_json, scope_json, status, created_by)
       VALUES (?, ?, 'mysql', ?, ?, ?, 'connected', 'eval-seed')
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), type = 'mysql', config_json = VALUES(config_json),
         schema_json = VALUES(schema_json), scope_json = VALUES(scope_json),
         status = 'connected', updated_at = NOW()`,
      [id, name, JSON.stringify(config), schemaJson, scopeJson]
    );
    console.log(`[eval-seed] 数据源已注册：${id}（${name}）${description}`);
  }
  await upsertDs(EVAL_CRM_DS_ID, '智能问数评测库', null, '');
  await upsertDs(EVAL_CRM_DEPT1_DS_ID, '业务一部评测库（行级过滤）', dept1Scope, '— scope.rowFilters: clients.ownerId/visits.ownerName/users.departmentId 部门谓词');

  // 6. golden SQL 执行验证（标注规范第五节：新增用例必须先过执行验证）
  const suite = loadEvalCases();
  const resultCases = suite.cases.filter((c) => c.expect === 'result');
  let verified = 0;
  const failures: string[] = [];
  for (const c of resultCases) {
    try {
      await crm.query(c.goldenSql);
      verified += 1;
    } catch (err: any) {
      failures.push(`${c.id}: ${err?.message || err}`);
    }
  }
  if (failures.length > 0) {
    console.error(`[eval-seed] golden SQL 执行验证失败（${failures.length} 条）:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`[eval-seed] golden SQL 执行验证通过：${verified}/${resultCases.length} 条全部可执行（跳过 clarify/refuse 占位 ${suite.cases.length - resultCases.length} 条）`);
  }

  await crm.end();
  await appPool.end();
  console.log('[eval-seed] 完成');
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`[eval-seed] 自检失败：${msg}`);
}

main().catch((err) => {
  console.error('[eval-seed] 运行失败:', err?.message || err);
  process.exit(1);
});
