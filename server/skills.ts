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

/**
 * 内置系统技能：面向不良资产经营分析场景设计，模板措辞内嵌权威口径提示
 * （核算版 BB=1、月末快照、长龄 60 个月等），与语义指标层/知识库口径一致；
 * 多数技能零占位符，点击即可一键提问。
 */
export const BUILTIN_SKILLS: SkillDef[] = [
  {
    id: 'org-biz-profile',
    name: '机构业务画像',
    description: '按机构盘点业务笔数、本年投放、长龄与逾期，定位头部机构',
    promptTemplate: '请按机构名称统计业务笔数、本年投放金额、长龄业务笔数和逾期金额（统计口径均为核算版），按本年投放金额降序排列，指出规模前三的机构',
    placeholders: [],
  },
  {
    id: 'aged-asset',
    name: '长龄资产分析',
    description: '长龄业务（最早授信距宽表月份≥60个月）的机构分布与集中度',
    promptTemplate: '请按机构名称统计长龄业务笔数（核算版且 SFCL 为是），并计算长龄业务占全部业务笔数的比例，指出长龄化程度最高的机构',
    placeholders: [],
  },
  {
    id: 'risk-project',
    name: '风险项目监控',
    description: '风险项目台账口径的机构分布与集中度预警',
    promptTemplate: '请统计风险项目总数，并按机构名称统计风险项目个数（核算版），指出风险项目最集中的机构',
    placeholders: [],
  },
  {
    id: 'overdue-asset',
    name: '逾期资产分析',
    description: '逾期金额与逾期笔数按业务分类分布，定位清收重点',
    promptTemplate: '请按业务分类统计逾期金额和逾期业务笔数（核算版且 SFYQ 为是），按逾期金额降序排列，指出逾期最集中的业务分类',
    placeholders: [],
  },
  {
    id: 'return-analysis',
    name: '投资收益分析',
    description: '按科目一级分类看当年/累计投资收益（财务宽表最新月末快照）',
    promptTemplate: '请按科目一级分类统计当年投资收益和累计投资收益（财务宽表、核算版、取最新月末快照），按当年投资收益降序排列',
    placeholders: [],
  },
  {
    id: 'scale-trend',
    name: '月末规模趋势',
    description: '按月末快照观察累计投放走势（不跨月末累加）',
    promptTemplate: '请按月末快照日期逐月展示累计投放金额的变化趋势（核算版），并指出趋势拐点；注意每个月末是当月全量快照，不要跨月末累加',
    placeholders: [],
  },
  {
    id: 'biz-structure',
    name: '业务结构分析',
    description: '五大业务分类（收购处置/重组/债项/权益/其他）投放结构',
    promptTemplate: '请计算各业务分类在本年投放金额中的占比（核算版），用饼图展示结构分布，并指出主导业务类型',
    placeholders: [],
  },
  {
    id: 'stock-vs-new',
    name: '存量与新增对比',
    description: '存量项目与当年新增项目的机构对比，识别经营模式差异',
    promptTemplate: '请按机构名称对比存量项目数与当年新增项目数（核算版），指出以存量经营为主的机构和新增投放能力强的机构',
    placeholders: [],
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
