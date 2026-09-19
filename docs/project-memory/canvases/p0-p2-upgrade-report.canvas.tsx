import { Callout, Card, CardBody, Divider, Grid, H1, H2, Stack, Stat, Table, Tag, Text, canvasImage } from 'qoder/canvas';

const feedbackScreenshot = canvasImage('./verify-feedback-ui.png');

export default function P0P2UpgradeReport() {
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>企业级改造完成报告（P0 → P1 → P2）</H1>
        <Text tone="secondary" size="small">
          智能问数系统 · 依据《企业级评估报告》优先级清单依次实施 · 2026-08-11 全部完成并验证
        </Text>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat value="9" label="落地改造项" tone="success" />
        <Stat value="112" label="单元测试全过" description="新增 16 个（加密7/AST5/bigram4）" />
        <Stat value="0" label="tsc / eslint 错误" tone="success" />
        <Stat value="3" label="端到端实测链路" description="live 问数 / 反馈闭环 / few-shot" />
      </Grid>

      <Divider />

      <H2>P0 安全加固（上生产前必须）</H2>
      <Table
        headers={['改造项', '实施方案', '实测证据']}
        rows={[
          ['数据源凭据加密落库', 'AES-256-GCM 零依赖加密（enc:v1: 前缀幂等）；3 个写入点加密、连接前解密；启动时就地加密存量明文', 'DB 中 password 已为 enc:v1: 密文；live 问数正常（解密链路正确）'],
          ['JWT 密钥 fail-fast', '生产环境缺 JWT_SECRET 直接拒绝启动；管理员默认密码每次启动强告警', '启动日志出现「管理员仍在使用默认密码」告警'],
          ['Web 安全基线', 'nosniff / X-Frame-Options / Referrer-Policy 全量生效；生产追加 HSTS + CSP；请求体 2mb 限制', 'curl 响应头确认全部生效'],
        ]}
      />

      <H2>P1 核心能力差距补齐</H2>
      <Table
        headers={['改造项', '实施方案', '实测证据']}
        rows={[
          ['SQL AST 二道防线', 'node-sql-parser 语法树复核：语句类型全 select + AST 表引用全在白名单；解析失败放行不误伤（正则防线兜底）', '5 个新测试覆盖；合法 JOIN/子查询双层校验下仍通过'],
          ['问答反馈闭环', 'query_feedback 表 + POST /api/query/feedback；问数卡片头部 👍/👎，提交后变色置灰防重复', '浏览器实测：toast「感谢反馈，该问答已加入样例库」+ 绿色高亮；DB 3 条落库记录'],
          ['Few-shot 样例库', '点赞的 live 问答自动成样例；下次提问按中文 bigram 相似度检索 top3 注入阶段一 prompt', '相似问题成功检索到点赞样例并注入；live 链路在样例注入下返回真实数据 3 行'],
        ]}
      />

      <H2>P2 演进基础</H2>
      <Table
        headers={['改造项', '实施方案', '实测证据']}
        rows={[
          ['可观测性基础', 'requestLogger 中间件：每请求 requestId + X-Request-Id 响应头 + API 访问日志（状态码/耗时/用户），鉴权前挂载', 'curl 确认 X-Request-Id 头；被拒请求同样有留痕'],
          ['容器化', '多阶段 Dockerfile（构建/运行分离、仅生产依赖、HEALTHCHECK、密钥全走环境变量）+ .dockerignore', 'npm run build 产物 dist/server.cjs 构建成功'],
        ]}
      />

      <Divider />

      <H2>变更文件</H2>
      <Card>
        <CardBody>
          <Stack gap={8}>
            <Text size="small"><b>新增</b>：server/secretsCrypto.ts(+test)、server/queryFeedback.ts(+test)、server/requestLogger.ts、Dockerfile、.dockerignore</Text>
            <Text size="small"><b>修改</b>：server.ts、server/db.ts、server/liveQuery.ts、server/sqlExecutor.ts(+test)、server/routes/datasources.ts、src/components/query/QueryChat.tsx、src/hooks/useAnalyticsStore.ts、src/types/analytics.ts、package.json（+node-sql-parser）</Text>
          </Stack>
        </CardBody>
      </Card>

      <H2>浏览器端到端验证</H2>
      <Card>
        <CardBody>
          <Stack gap={10}>
            <Text size="small">
              admin 登录 → 智能问数「各客户类型的客户数量」→ live 真实数据 3 行（产业客户 198 / 地方政府 28 / 金融机构 33）→ 回答卡片头部点赞按钮点击 → toast + 绿色高亮置灰 → DB 落库确认。
            </Text>
            <img src={feedbackScreenshot} alt="问答反馈功能浏览器验证截图：绿色高亮点赞按钮与真实数据徽标" style={{ width: '100%', maxWidth: 480, borderRadius: 8 }} />
          </Stack>
        </CardBody>
      </Card>

      <Callout tone="warning" title="部署提醒">
        生产部署必须注入 JWT_SECRET（缺失将拒绝启动），建议另设 DS_SECRET_KEY 与 JWT 分离；当前 admin 仍为默认密码，请尽快登录修改。依赖外部基础设施的项（Redis 异步队列、SSO、Prometheus、多源 Connector）建议到企业部署阶段立项实施。
      </Callout>

      <Stack gap={6}>
        <Text size="small" tone="secondary">遗留可选项：</Text>
        <Stack gap={4}>
          <Tag tone="neutral">Redis 限流/异步任务队列</Tag>
          <Tag tone="neutral">SSO / OIDC 企业集成</Tag>
          <Tag tone="neutral">多数据源 Connector 抽象</Tag>
          <Tag tone="neutral">TypeScript strict 模式排期</Tag>
        </Stack>
      </Stack>
    </Stack>
  );
}
