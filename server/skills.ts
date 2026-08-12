/**
 * P2-A Skills 插件系统（借鉴 DB-GPT Skills 驱动的可扩展性）。
 * 把高频、可复用的分析方法封装为「技能」：自然语言问题模板 + 占位符。
 * 用户选中技能后将模板填入问数输入框，替换占位符即可提交；
 * SQL 仍由 NL2SQL 链路生成，技能只提供结构化的提问范式，不绕过安全执行层。
 */

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  /** 自然语言问题模板，{{占位符}} 由用户替换 */
  promptTemplate: string;
  /** 模板中的占位符名（与 promptTemplate 内 {{}} 对应） */
  placeholders: string[];
}

export const BUILTIN_SKILLS: SkillDef[] = [
  {
    id: 'customer-segment',
    name: '客户分层分析',
    description: '按客户维度分层统计数量与核心指标，识别重点客群',
    promptTemplate: '请按{{客户维度}}统计客户数量与{{核心指标}}，按{{核心指标}}降序排列，识别重点客群',
    placeholders: ['客户维度', '核心指标'],
  },
  {
    id: 'npl-analysis',
    name: '不良资产分析',
    description: '分析不良贷款余额、不良率及其在不同维度上的分布',
    promptTemplate: '请统计{{分析维度}}的不良贷款余额与不良率，并按不良率降序排列，指出风险最集中的{{分析维度}}',
    placeholders: ['分析维度'],
  },
  {
    id: 'time-trend',
    name: '时间趋势对比',
    description: '按时间粒度观察指标走势，识别拐点与趋势',
    promptTemplate: '请按{{时间粒度}}统计{{指标}}的变化趋势，并指出明显的上升或下降拐点',
    placeholders: ['时间粒度', '指标'],
  },
  {
    id: 'structure-ratio',
    name: '结构占比分析',
    description: '计算各分类在总量中的占比，观察结构分布',
    promptTemplate: '请计算各{{分类维度}}的{{指标}}占比，用饼图展示结构分布，并指出占比最高的前几项',
    placeholders: ['分类维度', '指标'],
  },
  {
    id: 'top-n',
    name: 'TOP N 排名',
    description: '按指标对维度排名，快速定位头部与尾部',
    promptTemplate: '请统计{{维度}}的{{指标}}，取排名前 {{N}} 名，并给出每名的具体数值',
    placeholders: ['维度', '指标', 'N'],
  },
];

export function getSkills(): SkillDef[] {
  return BUILTIN_SKILLS;
}

export function getSkill(id: string): SkillDef | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}

/** 将占位符 {{key}} 替换为用户填写的值；未填写的占位符原样保留，提示用户继续补全 */
export function fillSkillTemplate(template: string, values: Record<string, string>): string {
  return String(template || '').replace(/{{\s*([^}]+?)\s*}}/g, (match, key) => {
    const v = values[String(key).trim()];
    return typeof v === 'string' && v.trim() ? v.trim() : match;
  });
}
