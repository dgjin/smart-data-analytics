import {
  Callout,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  Stack,
  Stat,
  Table,
  Tag,
  Text,
  Timeline,
  canvasImage,
} from 'qoder/canvas';

// 本地图片须用相对画布文件的路径：截图已复制到 canvases/ 目录同级
const shotCountDistinct = canvasImage('./v0410-fix-verify-step5-countd.png');
const shotNoOrder = canvasImage('./v0410-fix-verify-step7-noorder.png');
const shotPivot = canvasImage('./flex0410-08b-pivot-table.png');
const shotCsv = canvasImage('./flex0410-09-csv-toast.png');

export default function FlexQueryAgileV0410Report() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>v0.4.10 灵活查询「参照 Agile Query 增强」完成报告</H1>
        <Text tone="secondary">
          智能问数据分析系统 · NL2SQL Pro v0.4.10 · 完成时间 2026-08-19 · 服务环境
          http://127.0.0.1:3000（MySQL analytics_test / fct_jc_main_biz_stat 120,119 行真实数据）
        </Text>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat label="新增增强项" value="9" description="查询表达力 + 分析体验" tone="success" />
        <Stat label="单测用例" value="531" description="51 文件全部通过（基线 522 → 531）" tone="success" />
        <Stat label="构建器测试" value="20" description="flexQueryBuilder.test.ts（11 → 20）" />
        <Stat label="E2E 验证" value="11 + 3" description="主流程 11 步 + bug 修复 3 复验点全过" tone="success" />
      </Grid>

      <Divider />

      <H2>一、成果总览（对照 Agile Query 特性裁剪落地）</H2>
      <Callout tone="info" title="参照说明">
        经调研 agiquery.com 官方特性（自动 SQL 生成、搜索式字段定位、透视图、类 Excel 快速计算、查询历史），
        结合本项目单表聚合 + 安全白名单架构，多表自动 JOIN 未纳入，其余特性全部落地。
      </Callout>
      <Table
        headers={['分类', '增强项', '说明']}
        rows={[
          ['① 查询表达力', '去重计数聚合', 'COUNT(DISTINCT col)，别名前缀 countd_，UI 聚合下拉新增「去重计数」'],
          ['① 查询表达力', 'BETWEEN 区间筛选', '「最小值, 最大值」中英文逗号均可，端点数 ≠ 2 直接拒绝'],
          ['① 查询表达力', 'IS NULL / IS NOT NULL', '无值操作符跳过空值校验，UI 自动隐藏值输入框'],
          ['① 查询表达力', '指标过滤 HAVING', '紫色拖放区，重复聚合表达式写法兼容 MySQL/PG 双方言'],
          ['① 查询表达力', '自由排序目标', '可选任意指标别名或维度列 + 升/降序，「不排序」可清除 ORDER BY'],
          ['② 分析体验', '字段搜索', '左栏按名称/描述实时过滤 94 个字段'],
          ['② 分析体验', '占比快速计算', '首指标占总和百分比，客户端追加 pct_ 列（如 6.77%）'],
          ['② 分析体验', '透视图', '2 维度 + 1 指标时行列交叉渲染（机构 × 报告期 20 列），不额外查库'],
          ['② 分析体验', 'CSV 导出 / 查询历史', 'BOM 头兼容 Excel 中文；localStorage 上限 8 条、按配置去重、一键还原'],
          ['③ 兼容与修复', '旧配置迁移 + 排序自愈', 'orderByFirstMeasure 自动迁移；聚合变更后失效排序别名自动校正'],
        ]}
      />

      <H2>二、关键步骤</H2>
      <Timeline
        events={[
          {
            id: 's1',
            timestamp: 'Step 1',
            title: '调研 Agile Query 特性与安全边界',
            description: 'WebSearch/WebFetch 官网特性清单；确认 sqlExecutor FORBIDDEN_PATTERN 仅拦写操作，HAVING / COUNT DISTINCT / BETWEEN / IS NULL 均可通过',
            state: 'completed',
            tone: 'success',
          },
          {
            id: 's2',
            timestamp: 'Step 2',
            title: 'SQL 构建器重写（135 → 215 行）',
            description: 'FlexQueryConfig 升级：orderBy: FlexOrderBy | null + havings: FlexHaving[]；测试 11 → 20 用例',
            state: 'completed',
            tone: 'success',
          },
          {
            id: 's3',
            timestamp: 'Step 3',
            title: 'FlexQueryBuilder.tsx 四批改造（742 → 1021 行）',
            description: '字段搜索 / HAVING 拖放区 / 双下拉排序 / 占比 / 透视 / CSV / 历史 全部落地',
            state: 'completed',
            tone: 'success',
          },
          {
            id: 's4',
            timestamp: 'Step 4',
            title: '静态验证',
            description: 'lint 通过；bun test 531/531 通过（51 文件）',
            state: 'completed',
            tone: 'success',
          },
          {
            id: 's5',
            timestamp: 'Step 5',
            title: '浏览器 E2E 11 步全过，发现真实 bug',
            description: '聚合切换后 orderBy 旧别名残留阻塞执行 + 「不排序」无法清除',
            state: 'completed',
            tone: 'warning',
          },
          {
            id: 's6',
            timestamp: 'Step 6',
            title: 'bug 修复 + 复验 + 文档徽标',
            description: 'useEffect 自动校正 + isOrderByValid 展示校验；浏览器 3 复验点全过；说明书 v0.4.10 + Header 徽标更新',
            state: 'completed',
            tone: 'success',
          },
        ]}
      />

      <H2>三、变更文件清单</H2>
      <Table
        headers={['文件', '变更', '规模']}
        rows={[
          ['src/utils/flexQueryBuilder.ts', '重写：HAVING / BETWEEN / 空值 / COUNT_DISTINCT / 自由排序', '135 → 215 行'],
          ['src/utils/flexQueryBuilder.test.ts', '重写：9 个新用例覆盖全部新语法与拒绝路径', '11 → 20 用例'],
          ['src/components/flexquery/FlexQueryBuilder.tsx', '四批大改 + bug 修复（排序自愈）', '742 → 1021 行'],
          ['src/components/Header.tsx', '徽标 v0.4.9 → v0.4.10', '1 行'],
          ['docs/系统功能说明书.md', '适用版本 + v0.4.10 变更记录（三段式）', '+2 处'],
          ['server/sqlExecutor.ts', '只读调研：确认安全校验边界，无改动', '—'],
        ]}
      />

      <H2>四、验证证据</H2>
      <Grid columns={2} gap={16}>
        <Callout tone="success" title="测试与类型检查">
          bun test：531 通过 / 0 失败（51 文件）；其中 flexQueryBuilder.test.ts 20 用例覆盖
          COUNT_DISTINCT 别名、BETWEEN 端点校验、IS NULL、HAVING 双方言表达式、排序合法性与拒绝路径。
        </Callout>
        <Callout tone="success" title="浏览器 E2E（真实数据库执行）">
          主流程 11 步：字段搜索过滤 94 字段 → COUNT(DISTINCT) SQL → BETWEEN → HAVING 真实执行 →
          维度排序 → 占比列 6.77% → 机构 × 报告期 20 列透视表 → CSV 100 行导出 →
          历史还原 SQL 逐字一致 → 固化回归正常，控制台无 error/warning。
        </Callout>
      </Grid>
      <Table
        headers={['bug 修复复验点', '结果', 'SQL 证据']}
        rows={[
          [
            '复验点 1：求和 → 去重计数',
            '通过：无校验错误，执行按钮可用，执行成功 29 行 / 229ms',
            'ORDER BY `countd_bntfje` DESC（旧别名自动校正）',
          ],
          [
            '复验点 2：选「不排序」',
            '通过：下拉显示「不排序」，受控值一致',
            'ORDER BY 子句完全消失',
          ],
          [
            '复验点 3：删除唯一指标',
            '通过：排序自动降级为维度排序，无残留失效别名',
            'ORDER BY `JGMC` DESC',
          ],
        ]}
        rowTone={['success', 'success', 'success']}
      />

      <CollapsibleSection title="E2E 截图证据（本次目标工作中生成并核实存在）" defaultOpen>
        <Stack gap={12}>
          <Stack gap={4}>
            <Text size="small" tone="secondary">复验点 1：聚合切换后 ORDER BY 自动校正为 countd_bntfje</Text>
            <img src={shotCountDistinct} alt="切换去重计数后排序自动校正" style={{ maxWidth: '100%', borderRadius: 8 }} />
          </Stack>
          <Stack gap={4}>
            <Text size="small" tone="secondary">复验点 2：选「不排序」后 ORDER BY 消失且下拉显示一致</Text>
            <img src={shotNoOrder} alt="不排序选项生效" style={{ maxWidth: '100%', borderRadius: 8 }} />
          </Stack>
          <Grid columns={2} gap={12}>
            <Stack gap={4}>
              <Text size="small" tone="secondary">透视图：机构 × 报告期交叉表</Text>
              <img src={shotPivot} alt="透视表" style={{ maxWidth: '100%', borderRadius: 8 }} />
            </Stack>
            <Stack gap={4}>
              <Text size="small" tone="secondary">CSV 导出成功提示</Text>
              <img src={shotCsv} alt="CSV 导出" style={{ maxWidth: '100%', borderRadius: 8 }} />
            </Stack>
          </Grid>
        </Stack>
      </CollapsibleSection>

      <H2>五、最终结果</H2>
      <Stack gap={8}>
        <Text>
          v0.4.10 已完整交付：灵活查询在 v0.4.9 拖拉拽固定报表基础上，对齐 Agile Query 的查询表达力与分析体验，
          全部 9 项增强经 531 单测 + 浏览器真实数据库 E2E 验证；E2E 暴露的排序残留 bug 已修复并 3 点复验通过。
        </Text>
        <Stack gap={6}>
          <Text size="small">
            <Tag tone="success">已交付</Tag> Header 徽标 NL2SQL Pro v0.4.10 · 说明书 v0.4.10 变更记录已写入 ·
            服务端零改动（纯前端 + 构建器增强）· 旧版保存的查询配置自动迁移兼容
          </Text>
        </Stack>
      </Stack>
    </Stack>
  );
}
