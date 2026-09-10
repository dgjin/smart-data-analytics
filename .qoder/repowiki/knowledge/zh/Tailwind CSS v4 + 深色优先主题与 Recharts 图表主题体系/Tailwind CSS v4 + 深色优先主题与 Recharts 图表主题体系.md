---
kind: frontend_style
name: Tailwind CSS v4 + 深色优先主题与 Recharts 图表主题体系
category: frontend_style
scope:
    - '**'
source_files:
    - src/index.css
    - index.html
    - src/utils/uiTheme.ts
    - src/utils/chartThemes.ts
    - src/App.tsx
    - src/components/Header.tsx
    - vite.config.ts
    - package.json
---

## 1. 使用的样式系统

- **CSS 框架**：Tailwind CSS v4（`tailwindcss@^4.1.14`），通过 `@tailwindcss/vite` 插件在 Vite 中启用，入口为 `src/index.css` 中的 `@import "tailwindcss"`。
- **构建工具集成**：`vite.config.ts` 的 `plugins: [react(), tailwindcss()]`，并通过 `resolve.alias['@']` 指向项目根目录，组件内统一使用 `@/...` 别名引用资源。
- **图标库**：`lucide-react`（`^0.546.0`），所有按钮、状态指示、导航图标均从该库导入（如 `Sparkles`、`Database`、`Sun`、`Moon`、`Lock` 等）。
- **动画库**：`motion`（Framer Motion 子集，`^12.23.24`），用于页面/组件级过渡动画。
- **图表库**：`recharts@^3.10.1`，配合自研 `chartThemes.ts` 提供多套配色方案。
- **状态管理**：Zustand（`zustand@^5.0.14`）用于 UI 状态（如金额单位、分析上下文），不直接参与样式但驱动主题切换事件。

## 2. 核心文件与职责

| 文件 | 作用 |
|---|---|
| `src/index.css` | Tailwind 入口；定义浅色主题重映射（覆盖 `--color-slate/*`、`--color-indigo/*` 等 CSS 变量），实现“深色默认 + 浅色可选”的双主题 |
| `index.html` | 应用壳；在 `<script>` 中读取 `localStorage('app-ui-theme')` 并在渲染前给 `<html>` 添加 `light` 类，避免闪烁 |
| `src/utils/uiTheme.ts` | 主题切换 API：`getUITheme()` / `applyUITheme(mode)` / `toggleUITheme()`，通过 `document.documentElement.classList.toggle('light', ...)` 切换，并派发 `UI_THEME_EVENT` 自定义事件 |
| `src/utils/chartThemes.ts` | 图表主题定义：`CHART_THEMES` 记录 cyber/print/accessible/executive/emerald/vivid 六套色板，含 `getAutoOptimizedColors` 智能对比度优化器 |
| `src/App.tsx` | 根布局：`bg-slate-950 text-slate-100 font-sans antialiased` 作为全局深色基调 |
| `src/components/Header.tsx` | 顶部栏：集中展示品牌渐变、数据源选择、权限申请、金额单位、主题切换按钮（Sun/Moon），是主题切换的主要交互入口 |
| `vite.config.ts` | 注入 `VITE_APP_VERSION` 到 `import.meta.env`，供 Header 显示版本号；配置 CSP 头允许 `unsafe-inline` 样式 |

## 3. 架构与设计约定

### 3.1 主题策略：深色优先 + CSS 变量重映射

- 默认主题为深色，直接使用 Tailwind 内置的 `slate-*` 色阶（`bg-slate-950` 页面底、`bg-slate-900` 卡片/面板、`text-slate-100` 主文字、`border-slate-800` 分隔线）。
- 浅色主题通过在 `html.light` 下重写 CSS 变量实现，而非引入独立样式表。`index.css` 将 `slate-950→#f1f5f9`、`slate-900→#ffffff`、`slate-100→#0f172a` 等一一翻转，同时调整强调色（indigo/cyan/violet/emerald/rose/amber）以保证浅底可读性。
- 针对特定场景（靛蓝气泡背景上的浅色文字）做了精细覆盖：`.bg-indigo-600\/90 .text-slate-300` 强制恢复近白色，并微调字重与边框透明度。
- 主题持久化键为 `app-ui-theme`，值为 `'light'` 或默认暗色；切换时触发 `UI_THEME_EVENT` 自定义事件，Header 等组件监听以同步图标状态。

### 3.2 组件级样式约定

- 所有组件使用 **Tailwind 原子类** 直接写在 `className` 中，无独立 `.css` 模块或 styled-components。
- 颜色语义：
  - 表面层：`bg-slate-950`（页面）、`bg-slate-900`（卡片）、`bg-slate-800`（次级容器）
  - 文字：`text-slate-100`（主）、`text-slate-400`（次要）、`text-slate-300`（标签）
  - 强调色：`indigo-600`（主操作）、`cyan-400`（辅助高亮）、`emerald-400`（成功/已连接）、`amber-300`（警告/权限申请）、`rose-300`（错误）
  - 半透明叠加：大量使用 `/opacity` 修饰符如 `bg-slate-800/80`、`border-indigo-500/30`
- 圆角与阴影：统一 `rounded-xl` / `rounded-2xl`，按钮用 `shadow-md shadow-indigo-600/30` 营造悬浮感。
- 响应式：基于 Tailwind 断点 `sm:`、`md:`、`lg:`、`xl:`、`2xl:` 控制显隐（如 `hidden md:flex`、`hidden xl:inline-block`）。
- 图标：全部来自 `lucide-react`，尺寸统一 `w-4 h-4` / `w-5 h-5`，颜色跟随当前语义类。

### 3.3 图表主题体系

- `chartThemes.ts` 定义 6 套 `ChartTheme`，每套包含 `id`、`name`、`colors[]`、`gridColor`、`textColor`，部分标注 `isPrintFriendly` / `isAccessibilityFriendly`。
- `getAutoOptimizedColors(data, yAxisKeys, selectedThemeId)` 根据数据特征自动增强对比度：检测到负值时注入红/绿对比、收入 vs 利润双指标时切换互补色、多序列时最大化色轮间隔。
- 图表组件（`DynamicChart.tsx`、`KPIStats.tsx`、`DataTable.tsx`）消费这些主题，支持用户切换。

### 3.4 构建期常量注入

- `vite.config.ts` 将 `package.json.version` 注入为 `import.meta.env.VITE_APP_VERSION`，Header 中直接显示版本号，保证版本唯一事实源。

## 4. 约束与规范

- **禁止使用内联 style 属性**：所有视觉样式通过 Tailwind 类完成，仅极少数动态计算（如 chart 坐标）使用 JS 样式。
- **主题切换必须通过 `uiTheme.ts` 暴露的 API**：组件不得直接操作 `documentElement.classList`，应调用 `toggleUITheme()` 或监听 `UI_THEME_EVENT`。
- **浅色主题覆盖范围限定于 `html.light` 下的 CSS 变量重映射**：新增颜色需同时考虑深浅两种映射，避免只改深色态。
- **图表主题扩展需在 `chartThemes.ts` 中注册新条目**：新增配色方案必须遵循 `ChartTheme` 接口，并提供 `colors[]` 数组。
- **CSP 限制**：开发服务器通过 `vite.config.ts` 的 `server.headers` 注入 CSP，允许 `style-src 'self' 'unsafe-inline'`，因此样式必须以 Tailwind 类形式存在，不应依赖外部样式 CDN。
- **无第三方 UI 组件库**：未引入 Ant Design / Material / shadcn 等，所有交互控件（按钮、模态框、下拉选择、表格）均为手写 Tailwind 组件，保持风格一致。
- **字体**：全局使用 `font-sans antialiased`，未引入自定义字体文件（文档 PPT 除外）。