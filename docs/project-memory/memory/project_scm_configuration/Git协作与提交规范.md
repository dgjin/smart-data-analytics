---
title: "Git协作与提交规范"
usage_scenario:
    - "进行代码提交、推送或解决版本控制问题时参考"
keywords:
    - "Git"
    - "双远程"
    - "提交规范"
    - "main分支"
    - "GitHub"
    - "Gitee"
source: "init"
---

Git工作流规范:
1. 修改前拉取: `git pull origin main`
2. 提交推送: 代码修改完成后，执行 `git add -A` -> `git commit` (语义化message) -> 推送至双远程:
   - `git push origin main` (GitHub)
   - `git push gitee main` (Gitee镜像)

仓库配置:
- 主远程: origin = github.com/dgjin/smart-data-analytics
- 备份远程: gitee = gitee.com/dgjin/smart-data-analytics
- 分支: 仅 main 分支，禁止 force push
- 认证: GitHub走HTTPS+osxkeychain，Gitee走SSH
