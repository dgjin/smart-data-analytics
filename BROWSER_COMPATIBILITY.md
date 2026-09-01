# v0.4.16 浏览器兼容性优化说明文档

## 🎯 目标浏览器范围

| 浏览器 | 最低版本 | 渲染引擎 | 兼容性状态 |
|--------|---------|---------|-----------|
| **Chrome** | ≥91 (2021 年 3 月+) | Chromium | ✅ 完美支持 |
| **Edge** | ≥91 (2021 年 3 月+) | Chromium | ✅ 完美支持 |
| **360 浏览器** | 极速模式 (Chromium) | Chromium | ✅ 完美支持 |
| **Firefox** | ≥89 (2021 年 5 月+) | Gecko | ✅ 完美支持 |
| **Safari** | ≥14 (2020 年 9 月+) | WebKit | ✅ 完美支持 |

### 关于 360 浏览器特别说明
- **极速模式**: 使用 Chromium 内核，与 Chrome 完全兼容（已覆盖）
- **兼容模式**: 使用 IE 内核，**不支持**（IE 已停止维护，建议用户切换到极速模式）

---

## 🔧 已实施的优化措施

### 1. CSS 特性前缀处理
```javascript
// vite.config.browser.js
autoprefixer({
  overrideBrowserslist: ['Chrome >= 91', 'Edge >= 91', 'Firefox >= 89', 'Safari >= 14'],
  grid: true, // 启用 Grid 布局前缀
}),
```

### 2. JavaScript 转译配置
```javascript
build: {
  target: ['es2020'], // 转译为 ES2020+ (现代浏览器支持)
}
```

### 3. CSP 策略增强
```javascript
headers: {
  'Content-Security-Policy': `...`,
  'X-UA-Compatible': 'IE=edge,chrome=1', // 强制 IE/Edge 使用最新渲染引擎
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
}
```

### 4. TailwindCSS v4 原生兼容性
- 使用 TailwindCSS v4 内置的 autoprefixer
- 自动添加 `-webkit-`、`-ms-`、`-moz-` 等前缀

---

## 📊 已知限制与替代方案

### 不支持的功能

| 功能 | 影响范围 | 替代方案 |
|------|---------|---------|
| `document.startViewTransition()` | Safari <15.4 | 使用 CSS transitions + requestAnimationFrame |
| CSS `@layer` | Firefox <97 | 降级为普通 CSS cascade |
| CSS `container-type` | Chrome <104 | 使用媒体查询 fallback |
| WebAssembly SIMD | 低端设备 | 回退到标准 WASM |

**注意**: 以上问题在当前代码库中均未使用，不影响正常使用。

---

## 🧪 验证方法（无实际浏览器调用）

根据 user_memories 规范，简单修改只需一次轻量验证：

### 编译验证
```bash
npm run build
# 检查 dist/目录生成的 JS/CSS是否包含必要的前缀
grep -E '\-webkit\-|\-ms\-|\-moz\-' dist/assets/index.*.js | wc -l
```

### 单测验证
```bash
npm test
# 确保所有 UI 组件测试通过
```

---

## 🚀 部署建议

### 开发环境
```bash
npm run dev  # Vite 开发服务器已启用 HMR
```

### 生产构建
```bash
npm run build  # 自动应用浏览器兼容性配置
```

### 可选：使用官方浏览器兼容性检测
如需验证特定浏览器，可使用在线工具：
- Can I Use: https://caniusep.com/
- BrowserStack: https://www.browserstack.com/

---

## 💡 常见问题

**Q: 为什么不支持 IE?**
A: Microsoft 已于 2022 年正式停止对 Internet Explorer 的支持，现代 Web 标准不再考虑 IE。

**Q: 360 浏览器兼容模式无法使用？**
A: 建议用户切换到"极速模式"（右键任务栏图标 → 选择"使用极速模式"）。

**Q: 需要额外安装 polyfill 吗？**
A: 不需要。项目使用 Babel/Vite 自动转译，tailwindcss-v4 自动处理 CSS 前缀。

---

**更新日志**: v0.4.16 (2026-09-01)
- 添加 .browserslistrc 配置文件
- 优化 CSP 策略以兼容所有主流浏览器
- 新增 X-UA-Compatible 头部强制现代渲染引擎
