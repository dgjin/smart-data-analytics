/**
 * 按问题内容路由专家角色（persona），注入阶段二分析解读的 system prompt。
 * 规则：按优先级顺序做关键词包含匹配，第一个命中的类别生效；均未命中时使用默认金融数据分析师。
 * 优先级语义：具体职能（风险/客户/财务）优先于宽泛领域（不良资产），避免「不良率」这类
 * 风险指标词被「不良」领域词抢先命中。
 */

export interface ExpertPersona {
  key: 'risk' | 'customer' | 'finance' | 'npl' | 'default';
  /** 展示用标签（前端回答卡片角标） */
  label: string;
  /** 阶段二 system prompt 的角色设定句 */
  rolePrompt: string;
}

interface PersonaRule {
  key: Exclude<ExpertPersona['key'], 'default'>;
  label: string;
  keywords: string[];
  rolePrompt: string;
}

const RULES: PersonaRule[] = [
  {
    key: 'risk',
    label: '不良资产风险管理专家',
    keywords: ['风险', '逾期', '违约', '不良率', '拨备', '损失', '催收', '诉讼', '抵押', '担保', '风控', '缓释', '预警', '迁徙'],
    rolePrompt:
      '你是不良资产从业的风险管理专家，擅长从数据中分析风险。解读时聚焦风险敞口、逾期与违约特征、风险迁徙与缓释状况，指出数据中暴露的风险信号并给出风险提示与管控建议。',
  },
  {
    key: 'customer',
    label: '不良资产客户分析管理专家',
    keywords: ['客户', '借款人', '债务人', '欠款人', '画像', '分层', '分群', '拜访', '回访', '联系'],
    rolePrompt:
      '你是不良资产客户分析管理的专家，擅长数据分析。解读时聚焦客户结构、分层画像、拜访与联系行为特征，给出客户分类管理与差异化经营建议。',
  },
  {
    key: 'finance',
    label: '专业财务分析师',
    keywords: ['财务', '营收', '收入', '利润', '成本', '费用', '资产负债', '现金流', '毛利', '净利', '账务', '资金', '回款'],
    rolePrompt:
      '你是专业的财务分析师。解读时聚焦收入、成本、利润、现金流等财务表现，关注口径一致性与结构性变化，给出财务视角的专业结论。',
  },
  {
    key: 'npl',
    label: '资深不良资产从业者',
    keywords: ['不良', '资产包', '处置', '债权', '抵债', '核销', '清收', '回收'],
    rolePrompt:
      '你是资深的不良资产从业者，擅长数据分析。解读时聚焦资产包结构、处置进度、清收与回收表现，给出处置策略与经营建议。',
  },
];

const DEFAULT_PERSONA: ExpertPersona = {
  key: 'default',
  label: '金融数据分析师',
  rolePrompt: '你是专业的金融数据分析师。基于真实数据给出专业、严谨、可落地的分析结论。',
};

/** 按问题文本命中关键词路由专家角色；无任何命中时返回默认金融数据分析师 */
export function resolveExpertPersona(question: string): ExpertPersona {
  const q = String(question || '');
  for (const rule of RULES) {
    if (rule.keywords.some((k) => q.includes(k))) {
      return { key: rule.key, label: rule.label, rolePrompt: rule.rolePrompt };
    }
  }
  return DEFAULT_PERSONA;
}
