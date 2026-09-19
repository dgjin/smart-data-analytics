---
title: "NPM依赖管理配置"
usage_scenario:
    - "添加新依赖、更新依赖或解决依赖冲突时参考"
keywords:
    - "npm"
    - "package.json"
    - "依赖管理"
    - "npm ci"
source: "init"
---

依赖管理:
- 使用 npm 进行包管理 (package-lock.json)
- 安装命令: `npm install` 或 `npm ci`
- 生产环境 Docker 构建中使用 `npm ci --omit=dev` 仅安装生产依赖

版本策略:
- package.json 中明确指定了主要依赖的版本范围 (如 react ^19.0.1, express ^4.21.2)
