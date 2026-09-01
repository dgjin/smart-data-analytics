/**
 * v0.4.16 - 导入复杂 SQL 样例库到 query_feedback 表
 * 
 * 用途：为智能问数模块提供 few-shot 样例，引导 LLM 生成复杂 SQL（WITH/CTE、窗口函数、条件聚合等）
 * 数据源 ID: ds_1786620486498（数据资源库）
 * 样例数量：10 条复杂分析场景
 */

import mysql from 'mysql2/promise';

// 显式从 .env.local 加载变量（使用 dotenvx）
process.loadEnvFile('.env.local');

const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306');
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || 'dgjin@321'; // 默认从 .env.local
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'smart_analytics';

const DATA_SOURCE_ID = 'ds_1786620486498';

async function importComplexSqlSamples() {
  console.log('📊 开始导入复杂 SQL 样例库...');
  console.log(`   数据库：${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`);
  console.log(`   用户：${MYSQL_USER}`);
  console.log(`   数据源 ID: ${DATA_SOURCE_ID}\n`);

  let connection;
  try {
    // 建立数据库连接
    connection = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
    });

    console.log('✅ 数据库连接成功\n');

    // 检查 query_feedback 表是否存在
    const [tableExists] = await connection.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables 
       WHERE table_schema = ? AND table_name = 'query_feedback'`,
      [MYSQL_DATABASE]
    );

    if (Number((tableExists as any[])[0]?.cnt) === 0) {
      throw new Error('❌ 表 "query_feedback" 不存在，请先初始化数据库结构');
    }

    console.log('✅ 表结构验证通过\n');

    // 查询现有样例数量
    const [existingCount] = await connection.query(
      'SELECT COUNT(*) AS cnt FROM query_feedback WHERE data_source_id = ?',
      [DATA_SOURCE_ID]
    );
    const existingCnt = Number((existingCount as any[])[0]?.cnt);
    
    if (existingCnt > 0) {
      console.log(`⚠️  发现现有样例：${existingCnt} 条`);
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await readline.question('\n是否覆盖现有数据？(y/N): ');
      readline.close();
      
      if (!answer.toLowerCase().startsWith('y')) {
        console.log('👋 用户取消操作，退出。');
        return;
      }
      
      // 删除现有数据
      await connection.query('DELETE FROM query_feedback WHERE data_source_id = ?', [DATA_SOURCE_ID]);
      console.log('✅ 已删除现有数据\n');
    }

    // 准备 10 条复杂 SQL 样例
    const samples = [
      {
        question: '今年各季度不良贷款余额与去年同期的对比',
        sql: `WITH yr_curr AS (SELECT 'Q'||EXTRACT(QUARTER FROM dt) AS qtr, SUM(amt) AS amt FROM report_loan_data WHERE YEAR(dt)=2024 GROUP BY EXTRACT(QUARTER FROM dt)),
              yr_last AS (SELECT 'Q'||EXTRACT(QUARTER FROM dt) AS qtr, SUM(amt) AS amt FROM report_loan_data WHERE YEAR(dt)=2023 GROUP BY EXTRACT(QUARTER FROM dt))
SELECT c.qtr AS 季度，c.amt AS 2024 年不良余额，l.amt AS 2023 年同期不良余额，ROUND((c.amt-l.amt)/NULLIF(l.amt,0)*100,2) AS 同比% FROM yr_curr c LEFT JOIN yr_last l ON c.qtr=l.qtr ORDER BY c.qtr;`
      },
      {
        question: '本月各分行贷款余额与上月的变化趋势',
        sql: `SELECT team AS 分行，SUM(amt) AS 本月余额，LAG(SUM(amt)) OVER (ORDER BY team) AS 上月余额，
              ROUND(SUM(amt)-LAG(SUM(amt))OVER (ORDER BY team),2) AS 变化 
              FROM report_loan_data WHERE MONTH(dt)=MONTH(CURRENT_DATE)-1 GROUP BY team ORDER BY team;`
      },
      {
        question: '前 5 大客户贷款余额及占总体的占比',
        sql: `WITH total AS (SELECT SUM(amt) AS sum_amt FROM report_loan_data),
              ranked AS (SELECT customer_name,COUNT(1) AS n FROM report_loan_data GROUP BY customer_name ORDER BY COUNT(1) DESC LIMIT 5)
SELECT r.customer_name AS 客户，r.n AS 贷款笔数，ROUND(r.n*1.0/t.sum_amt*100,2) AS 占比 FROM ranked r CROSS JOIN total t ORDER BY r.n DESC;`
      },
      {
        question: '不同期限贷款的不良率与拨备覆盖率横向对比',
        sql: `SELECT CASE WHEN term IS NOT NULL THEN CONCAT(term,'个月') ELSE '未知' END AS 期限，
              SUM(CASE WHEN type='不良' THEN amt ELSE 0 END) AS 不良金额，
              SUM(CASE WHEN type='正常' THEN amt ELSE 0 END) AS 正常金额，
              ROUND(SUM(CASE WHEN type='不良' THEN amt ELSE 0 END)*1.0/SUM(CASE WHEN type IN ('正常','关注')THEN amt ELSE 0 END)*100,2) AS 不良率 %
FROM report_loan_data WHERE term IS NOT NULL OR term<>''GROUP BY term ORDER BY 项次;`
      },
      {
        question: '贷款金额分段统计（<50 万/50-200 万/200 万以上）',
        sql: `SELECT CASE WHEN amt<500000 THEN '<50 万'
              WHEN amt>=500000 AND amt<2000000 THEN '50-200 万'
              ELSE '≥200 万'END AS 金额段，COUNT(*) AS 笔数，SUM(amt) AS 总金额
              FROM report_loan_data GROUP BY 金额段 ORDER BY MIN(amt);`
      },
      {
        question: '各分行不良率、关注类比率、拨备覆盖率三指标横向对比',
        sql: `SELECT team AS 分行，
              ROUND(SUM(CASE WHEN type='不良' THEN amt ELSE 0 END)*1.0/SUM(amt)*100,2) AS 不良率%，
              ROUND(SUM(CASE WHEN type='关注' THEN amt ELSE 0 END)*1.0/SUM(amt)*100,2) AS 关注类率%，
              ROUND(SUM(CASE WHEN type='不良' THEN amt*0.15 ELSE 0 END)*1.0/SUM(CASE WHEN type IN ('不良','关注')THEN amt ELSE 0 END)*100,2) AS 拨备覆盖率%
FROM report_loan_data GROUP BY team ORDER BY team;`
      },
      {
        question: '逾期项目总金额与逾期项目数的平均逾期金额计算',
        sql: `WITH overdue_total AS (SELECT SUM(amt) AS total_amt,COUNT(*) AS cnt FROM report_loan_data WHERE status='逾期'),
              avg_amt AS (SELECT total_amt/cnt AS avg_val FROM overdue_total)
SELECT o.total_amt AS 逾期总金额，o.cnt AS 逾期项目数，a.avg_val AS 平均逾期金额 FROM overdue_total o,CROSS JOIN avg_amt a;`
      },
      {
        question: '不良贷款与关注类贷款的合计金额（多源合并）',
        sql: `SELECT '不良' AS category,SUM(amt) AS total_amt FROM report_loan_data WHERE type='不良'UNION ALL
              SELECT '关注',SUM(amt) FROM report_loan_data WHERE type='关注';`
      },
      {
        question: '本月排名前 10 的客户上月排名是多少',
        sql: `WITH monthly_rank AS (
              SELECT customer_name,RANK() OVER (ORDER BY SUM(amt)DESC) AS rn FROM report_loan_data WHERE MONTH(dt)=MONTH(CURRENT_DATE)-1 GROUP BY customer_name
              )
SELECT rn AS 排名，customer_name AS 客户 FROM monthly_rank WHERE rn<=10 ORDER BY rn;`
      },
      {
        question: '按客户等级分层统计贷款余额',
        sql: `SELECT grade AS 客户等级，SUM(amt) AS 总余额，COUNT(*) AS 客户数，AVG(amt) AS 户均余额
              FROM report_loan_data WHERE grade IS NOT NULL AND grade<>'' GROUP BY grade ORDER BY SUM(amt)DESC;`
      }
    ];

    console.log(`📝 准备插入 ${samples.length} 条复杂 SQL 样例...\n`);

    // 批量插入
    for (const sample of samples) {
      const [result] = await connection.query(
        `INSERT INTO query_feedback (user_id, username, data_source_id, question, executed_sql, verdict, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['test', 'admin', DATA_SOURCE_ID, sample.question, sample.sql, 'UP', 'MANUAL']
      );

      console.log(`✅ 已添加："${sample.question.substring(0, 30)}..." (${result.insertId})`);
    }

    // 验证最终数量
    const [finalCount] = await connection.query(
      'SELECT COUNT(*) AS cnt FROM query_feedback WHERE data_source_id = ?',
      [DATA_SOURCE_ID]
    );
    const finalCnt = Number((finalCount as any[])[0]?.cnt);

    console.log('\n🎉 导入完成！');
    console.log(`   新增样例数：${samples.length} 条`);
    console.log(`   数据源总样例数：${finalCnt} 条`);
    console.log(`\n💡 使用说明:`);
    console.log(`   - 这些样例将作为 few-shot 注入阶段一 prompt`);
    console.log(`   - LLM 会根据当前问题匹配相似场景的 SQL 写法`);
    console.log(`   - 支持复杂语法：WITH CTE、窗口函数、UNION ALL、条件聚合、派生表`);

  } catch (error: any) {
    console.error(`❌ 导入失败：${error.message}`);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n✅ 数据库连接已关闭');
    }
  }
}

// 运行导入脚本
importComplexSqlSamples();
