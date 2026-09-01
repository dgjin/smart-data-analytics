-- v0.4.15 复杂 SQL 样例导入（方案 A3）
-- 数据源 ID: ds_1786620486498（数据资源库）
-- 目标：补充 10 条复杂分析场景的 few-shot 样例（同比环比/TOP-N/条件聚合/CTE/窗口函数）
-- 用途：阶段一 prompt 按需召回样例引导 LLM 生成复杂 SQL

INSERT INTO query_feedback (user_id, username, data_source_id, question, executed_sql, verdict, provenance) VALUES
(1, 'admin', 'ds_1786620486498',
'今年各季度不良贷款余额与去年同期的对比',
'WITH yr_curr AS (SELECT ''Q''||EXTRACT(QUARTER FROM dt) AS qtr, SUM(amt) AS amt FROM report_loan_data WHERE YEAR(dt)=2024 GROUP BY EXTRACT(QUARTER FROM dt)),'
' yr_last AS (SELECT ''Q''||EXTRACT(QUARTER FROM dt) AS qtr, SUM(amt) AS amt FROM report_loan_data WHERE YEAR(dt)=2023 GROUP BY EXTRACT(QUARTER FROM dt))'
'SELECT c.qtr AS 季度，c.amt AS 2024 年不良余额，l.amt AS 2023 年同期不良余额，ROUND((c.amt-l.amt)/NULLIF(l.amt,0)*100,2) AS 同比% FROM yr_curr c LEFT JOIN yr_last l ON c.qtr=l.qtr ORDER BY c.qtr;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'本月各分行贷款余额与上月的变化趋势',
'SELECT team AS 分行，SUM(amt) AS 本月余额，LAG(SUM(amt)) OVER (ORDER BY team) AS 上月余额，'
'ROUND(SUM(amt)-LAG(SUM(amt))OVER (ORDER BY team),2)AS 变化 FROM report_loan_data WHERE MONTH(dt)=MONTH(CURRENT_DATE)-1 GROUP BY team ORDER BY team;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'前 5 大客户贷款余额及占总体的占比',
'WITH total AS (SELECT SUM(amt) AS sum_amt FROM report_loan_data),'
' ranked AS (SELECT customer_name,COUNT(1) AS n FROM report_loan_data GROUP BY customer_name ORDER BY COUNT(1) DESC LIMIT 5)'
'SELECT r.customer_name AS 客户，r.n AS 贷款笔数，ROUND(r.n*1.0/t.sum_amt*100,2) AS 占比 FROM ranked r CROSS JOIN total t ORDER BY r.n DESC;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'不同期限贷款的不良率与拨备覆盖率横向对比',
'SELECT CASE WHEN term IS NOT NULL THEN CONCAT(term,"个月") ELSE "未知" END AS 期限,'
'SUM(CASE WHEN type="不良" THEN amt ELSE 0 END) AS 不良金额,'
'SUM(CASE WHEN type="正常" THEN amt ELSE 0 END) AS 正常金额，'
'ROUND(SUM(CASE WHEN type="不良" THEN amt ELSE 0 END)*1.0/SUM(CASE WHEN type IN("正常","关注")THEN amt ELSE 0 END)*100,2) AS 不良率 %'
'FROM report_loan_data WHERE term IS NOT NULL OR term<>""GROUP BY term ORDER BY 项次;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'贷款金额分段统计（<50 万/50-200 万/200 万以上）',
'SELECT CASE WHEN amt<500000 THEN "<50 万"'
'WHEN amt>=500000 AND amt<2000000 THEN "50-200 万"'
'ELSE "≥200 万"END AS 金额段，COUNT(*) AS 笔数，SUM(amt) AS 总金额'
'FROM report_loan_data GROUP BY 金额段 ORDER BY MIN(amt);',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'各分行不良率、关注类比率、拨备覆盖率三指标横向对比',
'SELECT team AS 分行，'
'ROUND(SUM(CASE WHEN type="不良" THEN amt ELSE 0 END)*1.0/SUM(amt)*100,2) AS 不良率%，'
'ROUND(SUM(CASE WHEN type="关注" THEN amt ELSE 0 END)*1.0/SUM(amt)*100,2) AS 关注类率%，'
'ROUND(SUM(CASE WHEN type="不良" THEN amt*0.15 ELSE 0 END)*1.0/SUM(CASE WHEN type IN ("不良","关注")THEN amt ELSE 0 END)*100,2) AS 拨备覆盖率%'
'FROM report_loan_data GROUP BY team ORDER BY team;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'逾期项目总金额与逾期项目数的平均逾期金额计算',
'WITH overdue_total AS (SELECT SUM(amt) AS total_amt,COUNT(*) AS cnt FROM report_loan_data WHERE status="逾期"),'
'avg_amt AS (SELECT total_amt/cnt AS avg_val FROM overdue_total)'
'SELECT o.total_amt AS 逾期总金额，o.cnt AS 逾期项目数，a.avg_val AS 平均逾期金额 FROM overdue_total o,CROSS JOIN avg_amt a;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'不良贷款与关注类贷款的合计金额（多源合并）',
'SELECT "不良" AS category,SUM(amt) AS total_amt FROM report_loan_data WHERE type="不良"UNION ALL'
'SELECT "关注",SUM(amt) FROM report_loan_data WHERE type="关注";',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'本月排名前 10 的客户上月排名是多少',
'WITH monthly_rank AS ('
'SELECT customer_name,RANK() OVER (ORDER BY SUM(amt)DESC) AS rn FROM report_loan_data WHERE MONTH(dt)=MONTH(CURRENT_DATE)-1 GROUP BY customer_name'
')'
'SELECT rn AS 排名，customer_name AS 客户 FROM monthly_rank WHERE rn<=10 ORDER BY rn;',
'UP', 'MANUAL'),

(1, 'admin', 'ds_1786620486498',
'按客户等级分层统计贷款余额',
'SELECT grade AS 客户等级，SUM(amt) AS 总余额，COUNT(*) AS 客户数，AVG(amt) AS 户均余额'
'FROM report_loan_data WHERE grade IS NOT NULL AND grade<>"" GROUP BY grade ORDER BY SUM(amt)DESC;',
'UP', 'MANUAL');
