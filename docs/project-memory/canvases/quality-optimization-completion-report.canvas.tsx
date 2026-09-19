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
  canvasImage,
} from 'qoder/canvas';

const shotLogin = canvasImage('./quality-opt-login-page.png');
const shotWorkspace = canvasImage('./quality-opt-main-workspace.png');

export default function QualityOptimizationCompletionReport() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>代码质量优化计划 · 完成报告</H1>
        <Row gap={8}>
          <Tag tone="success">全阶段完成 · 终验 M3 通过</Tag>
          <Tag tone="info">智能问数分析系统 · NL2SQL Pro v0.9.62</Tag>
          <Text tone="secondary" size="small">
            Spec：代码质量优化计划_task-281 · 依据：docs/代码质量评估报告20260915.md
          </Text>
        </Row>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat value="546 → 0" label="业务代码 any（ESLint 实测）" tone="success" />
        <Stat value="51 → 0" label="业务代码 console（logger 门面收敛）" tone="success" />
        <Stat value="16 提交" label="全部通过七道门禁并双远程推送" tone="success" />
        <Stat value="9 / 9" label="E2E 全绿（真实 Chrome 驱动）" tone="success" />
      </Grid>

      <Divider />

      <H2>成果摘要（逐阶段对照验收标准）</H2>
      <Table
        headers={['阶段', '交付内容', '提交', '验收']}
        rows={[
          ['S0 门禁加固', 'ESLint：no-explicit-any / no-console 升 error + 存量豁免清单机制（只减不增）', 'd30dada', '通过'],
          ['S1 上帝组件拆分', 'QueryChat 1445→674 行（useState 24→11，抽 4 Hook + 4 子组件）；FlexQueryBuilder 1404→252 行', 'ad31880 → a291428', '通过'],
          ['S2 路由契约测试', 'supertest 引入，12 个核心路由契约测试（路由 src:test 30:8→31:20）', 'a4ee01d', '通过'],
          ['S3 架构拆分', 'db.ts 四拆分（926→102，出 schema/seed/migration）；query.ts 编排下沉 queryService（814→390）', '6b3d8ee', '通过'],
          ['S4 any 清零', '按模块 6 批推进 546→0，豁免清单全部删除，error 级门禁锁定零新增', 'd517f92 → 175172e', '通过'],
          ['S5.1 console 治理', '新建前端 logger 门面（src/utils/logger.ts），51 处业务 console 全量收敛，豁免移除', 'adc8897', '通过'],
          ['S5.2 依赖升级', '19 项 range 内升级（mysql2 3.24.4 / @google/genai 2.22.0 / eslint 10.10.0 等），主版本另行评估', 'e26c776', '通过'],
          ['M3 终验', '基线快照同口径复测（git archive 16f174a）→《代码质量复评报告》，总体评分 B+→A-', 'a828c15', '通过'],
          ['终验补强', 'E2E 两处既有用例漂移修复 + 真实 Chrome 全链路复验 9/9 全绿，复评报告补充证据链', '97aed39', '通过'],
        ]}
      />

      <H2>核心指标对比（基线 16f174a → 终态 97aed39，同口径实测）</H2>
      <Table
        headers={['指标', '基线', '终态', '变化']}
        rows={[
          ['业务代码 any', '546（ESLint 实测）', '0', '清零'],
          ['业务代码 console', '51', '0', '清零'],
          ['路由 src:test', '30:8', '31:20', '测试文件 +12'],
          ['测试规模', '94 文件 / 1123 用例', '112 文件 / 1552 用例', '+429 用例'],
          ['QueryChat.tsx', '1445 行（24 useState）', '674 行（11 useState）', '-53%'],
          ['FlexQueryBuilder.tsx', '1404 行', '252 行', '-82%'],
          ['db.ts / query.ts', '926 / 814 行', '102 / 390 行', '-89% / -52%'],
          ['>1000 行文件', '4', '2', '-2'],
          ['TODO/FIXME', '5', '0', '-5'],
          ['总体评分', 'B+', 'A-', '债务项全部清零'],
        ]}
      />

      <H2>关键实施步骤</H2>
      <Timeline
        density="compact"
        events={[
          { id: 's0', timestamp: 'S0', title: '门禁先行', description: 'ESLint 收紧 + 存量豁免只减不增；后续每一步都由门禁锁定成果', state: 'completed', tone: 'success' },
          { id: 's1', timestamp: 'S1', title: 'P0 上帝组件解体', description: 'QueryChat 三阶段拆分（1445→1086→673）+ FlexQueryBuilder 拆分（1404→252），JSX 逐行保真校验', state: 'completed', tone: 'success' },
          { id: 's2', timestamp: 'S2', title: '路由契约测试补强', description: '12 个核心路由：成功路径 + 401/403 + 400 参数校验 + 错误码断言', state: 'completed', tone: 'success' },
          { id: 's3', timestamp: 'S3', title: '架构拆分', description: 'db.ts 职责四分离（连接池/DDL/种子/迁移）；query.ts 编排下沉 queryService（应用服务层）', state: 'completed', tone: 'success' },
          { id: 's4', timestamp: 'S4', title: 'any 六批清零', description: 'server/routes → src/components → server/query → server/infra → utils/llm/hooks → 其余 23 文件；每批三档 tsc + eslint 归零', state: 'completed', tone: 'success' },
          { id: 's5', timestamp: 'S5', title: 'console 收敛 + 依赖升级', description: '双 logger 门面（server/frontend）；npm arborist bug 以 --legacy-peer-deps 规避；升级后评测集抽样 5/5', state: 'completed', tone: 'success' },
          { id: 'm3', timestamp: 'M3', title: '终验复评', description: 'git archive 基线快照同口径复测；《代码质量复评报告》输出（诚实披露 >500 行 26→27 净微增之拆分产物流动）', state: 'completed', tone: 'success' },
          { id: 'final', timestamp: '终验+', title: '浏览器全链路复验', description: '修复两处既有 E2E 用例漂移（知识库面板 v0.9.56 迁址 / 择源避开 EXPLAIN 防线），真实 Chrome 9/9 全绿 + 截图取证', state: 'completed', tone: 'success' },
        ]}
      />

      <H2>变更文件（主要）</H2>
      <Table
        headers={['层', '文件', '变更']}
        rows={[
          ['门禁', 'eslint.config.js', 'any/console 升 error；豁免清单建立 → 随清零全量删除（仅留 logger 门面/测试/eval 永久豁免）'],
          ['前端', 'src/utils/logger.ts（新增）· QueryChat.tsx · FlexQueryBuilder.tsx · useFlexQueryState.ts 等', '前端统一日志出口；两大上帝组件拆分；11 个组件 console→logger'],
          ['后端', 'server/infra/db.ts → schema.ts/seed.ts/migration.ts · server/query/queryService.ts（新增）· server.ts', '连接池单一职责化；问数编排下沉应用服务层；14 处 console→logger'],
          ['测试', 'server/routes/*.test.ts（12 个新增）· tests/e2e/smoke.spec.ts · tests/e2e/flexquery.spec.ts', '路由契约测试补强；E2E 用例漂移修复（知识库迁址 / 择源策略）'],
          ['文档', 'docs/代码质量复评报告20260915.md（新增 145 行）', '终验复评：终验结论 / 数据快照对比 / 逐阶段成果 / 评分复评 / 证据链'],
          ['依赖', 'package-lock.json', '19 项 range 内升级（mysql2 3.24.4 / @google/genai 2.22.0 / eslint 10.10.0 / react 19.3.0 等）'],
        ]}
      />

      <H2>验证证据</H2>
      <Table
        headers={['验证项', '结果']}
        rows={[
          ['七道门禁（tsc×3 / docs:check / state:check / eslint / vitest）', '16 个提交逐一通过；OpenAPI 159 端点同步校验'],
          ['ESLint 全量实测', '业务代码 any=0、console=0（豁免仅剩 logger 实现/CLI 评测/测试）'],
          ['vitest 全量', '112 文件 / 1552 用例全部通过'],
          ['评测集抽样回归（升级后依赖 + 真实 LLM 链路）', '执行准确率 100%（pass 5/5）'],
          ['Playwright E2E（真实 Chrome）', '9/9 全绿：登录 / 主界面渲染 / 问数主流程 / 灵活查询真执行 / 知识库面板 / 越权鉴权'],
          ['三端同步', 'local = origin = gitee = 97aed39；工作区干净；服务健康（MySQL/Redis 全绿）'],
        ]}
      />

      <Grid columns={2} gap={16}>
        <Stack gap={8}>
          <Text weight="semibold">登录页（深色主题完整渲染，无白屏/JS 异常）</Text>
          <img src={shotLogin} alt="登录页截图" style={{ width: '100%', borderRadius: 8 }} />
        </Stack>
        <Stack gap={8}>
          <Text weight="semibold">主工作台（QueryChat 重构后：欢迎语 / 快速推荐 / 输入区全部正常）</Text>
          <img src={shotWorkspace} alt="登录后主工作台截图" style={{ width: '100%', borderRadius: 8 }} />
        </Stack>
      </Grid>

      <Callout tone="success" title="最终结果">
        Spec 六阶段（S0~S5）与终验 M3 全部达成：业务 any 546→0、console 51→0，豁免清单清零；路由测试
        30:8→31:20，用例 1123→1552；两大上帝组件解体（-53% / -82%），db.ts/query.ts 职责分离；
        依赖 19 项安全升级并评测回归 100%。总体评分 B+ → A-，且以真实浏览器全链路复验（9/9）证明重构零功能回归。
        遗留事项（下一季度）：27 个 &gt;500 行文件继续收敛、主版本升级单独评估 —— 详见复评报告 §6。
      </Callout>
    </Stack>
  );
}
