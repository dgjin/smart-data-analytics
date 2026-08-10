# Ponytail (Qoder Plugin)

**来源**: https://github.com/DietrichGebert/ponytail （MIT License，作者 DietrichGebert）

## 功能

Ponytail 是一个编码风格约束技能：让 AI 像"最懒的资深工程师"一样工作——
优先质疑需求本身（YAGNI）、复用已有代码、使用标准库与平台原生能力、
能一行解决就不写五十行。支持三档强度：`lite` / `full`（默认）/ `ultra`。

触发方式：
- 在任何编码任务中说 "ponytail"、"懒一点"、"最简方案"、"yagni" 等关键词
- 使用 `/ponytail lite|full|ultra` 切换强度
- 说 "stop ponytail" / "normal mode" 退出

## 包含内容

- `skills/ponytail/SKILL.md` — 完整技能定义（与上游仓库逐字一致）
- `assets/avatar.svg` — 本地生成的占位图标（上游仓库未提供图标）

## 省略内容

无。上游 `skills/ponytail/` 目录仅包含 `SKILL.md`，无 references/scripts/ 等附加文件。

## 安装

```bash
mkdir -p ~/.qoder/skills/ponytail
cp skills/ponytail/SKILL.md ~/.qoder/skills/ponytail/SKILL.md
```

## 验证

已通过 `create-plugin` 离线校验器检查（manifest 字段、路径、frontmatter 均合法）。
