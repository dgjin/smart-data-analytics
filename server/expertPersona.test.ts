import { describe, expect, it } from 'vitest';
import { resolveExpertPersona } from './expertPersona';

describe('resolveExpertPersona: 按问题关键词路由专家角色', () => {
  it('财务类问题路由到专业财务分析师', () => {
    expect(resolveExpertPersona('各月份的营收与利润对比').key).toBe('finance');
    expect(resolveExpertPersona('上季度现金流情况').key).toBe('finance');
  });

  it('不良资产类问题路由到资深不良资产从业者', () => {
    expect(resolveExpertPersona('各资产包的处置进度').key).toBe('npl');
    expect(resolveExpertPersona('本月清收回收金额统计').key).toBe('npl');
  });

  it('客户类问题路由到不良资产客户分析管理专家', () => {
    expect(resolveExpertPersona('各客户类型的客户数量').key).toBe('customer');
    expect(resolveExpertPersona('债务人分层画像分布').key).toBe('customer');
  });

  it('风险类问题路由到不良资产风险管理专家', () => {
    expect(resolveExpertPersona('各地区逾期率与违约情况').key).toBe('risk');
    expect(resolveExpertPersona('抵押担保的风险缓释效果').key).toBe('risk');
  });

  it('无关键词命中时使用默认金融数据分析师', () => {
    const p = resolveExpertPersona('各部门的人数统计');
    expect(p.key).toBe('default');
    expect(p.label).toBe('金融数据分析师');
    expect(p.rolePrompt).toContain('金融数据分析师');
  });

  it('优先级：具体职能优先于宽泛领域词', () => {
    // 「不良率」是风险指标词，应先命中风险而非「不良」领域
    expect(resolveExpertPersona('各分行不良率排名').key).toBe('risk');
    // 含「客户」命中客户专家，即使同时含「不良」
    expect(resolveExpertPersona('不良客户的数量分布').key).toBe('customer');
  });

  it('空输入与非字符串输入安全兜底为默认角色', () => {
    expect(resolveExpertPersona('').key).toBe('default');
    expect(resolveExpertPersona(undefined as any).key).toBe('default');
  });
});
