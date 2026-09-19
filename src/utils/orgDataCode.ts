/**
 * 组织节点「数据标识」自动编码（层级路径编号）：
 * 机构 BR01；部门 {机构编码}-D01；团队 {部门编码}-T01。
 * 序号 = 同前缀已用编码最大值 + 1（两位补零，超过 99 自然进位三位）；父编码缺失时退化为 D01 / T01。
 * 规则与 server/routes/orgUnits.ts 的 buildDataCode 保持一致（服务端为权威实现，此处仅用于新建弹窗预填）。
 */
import type { OrgUnit, OrgUnitLevel } from '../types/analytics';

const SEQ_PAD = 2;
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

export function buildOrgDataCode(level: OrgUnitLevel, parentCode: string, existingCodes: Iterable<string>): string {
  if (level === 'HQ') return '';
  const local = level === 'BRANCH' ? 'BR' : level === 'DEPT' ? 'D' : 'T';
  const prefix = level === 'BRANCH' || !parentCode ? local : `${parentCode}-${local}`;
  const pattern = new RegExp(`^${prefix.replace(ESCAPE_RE, '\\$&')}(\\d+)$`);
  let max = 0;
  for (const code of existingCodes) {
    const matched = pattern.exec(String(code || '').trim());
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return `${prefix}${String(max + 1).padStart(SEQ_PAD, '0')}`;
}

/** 新增下级弹窗的预填值：父级数据标识作为前缀，序号取当前树已用编号递增 */
export function suggestOrgDataCode(units: OrgUnit[], parent: OrgUnit | null, level: OrgUnitLevel): string {
  return buildOrgDataCode(level, (parent?.dataCode ?? '').trim(), units.map((u) => u.dataCode));
}
