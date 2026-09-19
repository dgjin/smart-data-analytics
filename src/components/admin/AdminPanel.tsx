import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldCheck,
  UserPlus,
  RefreshCw,
  KeyRound,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Users,
  Gauge,
  BookMarked,
  Settings,
  Search,
  Radar,
  BookOpen,
  FileCode2,
  Ruler,
  ScrollText,
  UserCog,
  Activity,
  BellRing,
  Coins,
  FileDown,
  FileText,
  TrendingUp,
  AlertTriangle,
  Scale,
  Server,
  Network,
  Link2,
  X,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { UserRole, OrgUnit } from '../../types/analytics';
import { LlmUsagePanel } from './LlmUsagePanel';
import { OpsMetricsPanel } from './OpsMetricsPanel';
import { DriftAlertPanel } from './DriftAlertPanel';
import { ReportTemplateManager } from './ReportTemplateManager';
import { MetricsPanel } from './MetricsPanel';
import { IronRulesPanel } from './IronRulesPanel';
import { ExpertPersonasPanel } from './ExpertPersonasPanel';
import { AccessRequestsPanel } from './AccessRequestsPanel';
import { DlpDownloadPanel } from './DlpDownloadPanel';
import { EnvironmentConfigPanel } from './EnvironmentConfigPanel';
import { FallbackApprovalPanel } from './FallbackApprovalPanel';
import { ABTestDashboard } from './ABTestDashboard';
import { PatrolPanel } from './PatrolPanel';
// v0.9.66 组织架构树：面板 + 用户归属选择器 + 数据范围联动（节点数据共享 useOrgUnits）
import { OrgStructurePanel } from './OrgStructurePanel';
import { useOrgUnits } from '../../hooks/useOrgUnits';
import { OrgUnitPicker } from '../common/OrgUnitPicker';
// v0.9.56 规则治理整合：业务知识库与 SQL 样例库由「数据源与 Schema」迁入
import { KnowledgeBasePanel } from '../datasource/KnowledgeBasePanel';
import { SqlExamplesPanel } from '../datasource/SqlExamplesPanel';
// v0.9.57 分类内多面板统一顶部 Tab 分类条
import { SectionTabs, SectionTabItem } from './SectionTabs';
import { getErrorMessage } from '../../utils/errorUtils';
// v0.9.68 新建用户表单即时校验（规则与 server/auth/passwords.ts、server/routes/admin.ts 同步）
import { USERNAME_PATTERN, USERNAME_HINT, PASSWORD_HINT, checkPasswordStrength } from '../../utils/passwordStrength';

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  department?: string;
  /** v0.9.66 组织架构树：归属节点 ID（null/缺省 = 未关联组织，部门文本沿用旧值） */
  orgUnitId?: number | null;
  role: UserRole;
  status: 'ACTIVE' | 'DISABLED';
  mustChangePassword?: boolean;
  /** 组织数据范围（三层权限模型）：null/缺省 = 全辖不限制（与 server/query/orgScope.ts 同形） */
  orgScope?: UserOrgScope | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 组织数据范围档位：ALL 全辖 / ORG 本机构 / TEAM 本项目团队 / SELF 仅本人 */
type OrgScopeLevel = 'ALL' | 'ORG' | 'TEAM' | 'SELF';

interface UserOrgScope {
  level: OrgScopeLevel;
  orgs?: string[];
  teams?: string[];
  selfCode?: string;
}

const SCOPE_LEVEL_LABELS: Record<OrgScopeLevel, string> = {
  ALL: '全辖',
  ORG: '本机构',
  TEAM: '本项目团队',
  SELF: '仅本人经办',
};

/** 用户数据范围 → 简洁文案（列表展示用） */
function orgScopeText(scope?: UserOrgScope | null): string {
  if (!scope) return '全辖（不限制）';
  if (scope.level === 'ORG') return `机构：${(scope.orgs || []).join('、')}`;
  if (scope.level === 'TEAM') return `团队：${(scope.teams || []).join('、')}`;
  return `经办人：${scope.selfCode || ''}`;
}

/** v0.9.66 组织树模式推断：按已有数据范围配置判断能否用树表达（机构/团队取值全部命中节点 data_code）；SELF 与存量手填值无法映射时返回 null（转手动模式） */
function inferScopeTreeSelection(u: AdminUser, units: OrgUnit[]): number[] | null {
  const scope = u.orgScope;
  const hq = units.find((n) => n.level === 'HQ');
  if (!scope || scope.level === 'ALL') return hq ? [hq.id] : null;
  if (scope.level === 'SELF') return null;
  const codes = scope.level === 'ORG' ? scope.orgs || [] : scope.teams || [];
  if (codes.length === 0) return null;
  const ids: number[] = [];
  for (const code of codes) {
    const node = units.find((n) =>
      n.dataCode === code && (scope.level === 'ORG' ? n.level === 'BRANCH' : n.level === 'DEPT' || n.level === 'TEAM')
    );
    if (!node) return null;
    ids.push(node.id);
  }
  return ids;
}

/** v0.9.66 树多选 → 数据范围载荷：总部=ALL(不限制)；全为机构=ORG；全为部门/团队=TEAM；机构与部门/团队混选拒绝 */
function deriveScopeFromTree(ids: number[], units: OrgUnit[]): { payload?: UserOrgScope | null; error?: string } {
  const nodes = ids.map((id) => units.find((n) => n.id === id)).filter((n): n is OrgUnit => Boolean(n));
  if (nodes.length === 0) return { payload: null };
  if (nodes.some((n) => n.level === 'HQ')) {
    return nodes.length === 1 ? { payload: null } : { error: '总部代表全辖，不能与其他节点同时选择' };
  }
  const branches = nodes.filter((n) => n.level === 'BRANCH');
  const teamsLike = nodes.filter((n) => n.level === 'DEPT' || n.level === 'TEAM');
  if (branches.length > 0 && teamsLike.length > 0) {
    return { error: '机构与部门/团队不可混选（数据范围档位互斥），请分开配置' };
  }
  if (branches.length > 0) return { payload: { level: 'ORG', orgs: branches.map((n) => n.dataCode) } };
  return { payload: { level: 'TEAM', teams: teamsLike.map((n) => n.dataCode) } };
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: '管理员',
  ANALYST: '分析师',
  VIEWER: '只读用户',
};

/** 系统管理分类（8 项，左栏导航切换；v0.9.66 新增组织架构） */
type AdminSection =
  | 'users'
  | 'org-structure'
  | 'permission-approval'
  | 'rule-governance'
  | 'ai-audit'
  | 'quality-monitoring'
  | 'patrol'
  | 'system-config';

/** 左栏分类导航：三域分组容器化；color/bar 为选中态图标色与左侧色条（分类色系沿用既有编码，巡检用 orange）；
 *  group.text/line 为域图标色与标题延伸线渐变（v0.9.58：域卡片 + 加粗标题，分组辨识更清晰） */
const SECTION_GROUPS: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  line: string;
  items: { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }>; color: string; bar: string }[];
}[] = [
  {
    label: '账号与权限',
    icon: KeyRound,
    text: 'text-indigo-400',
    line: 'from-indigo-500 to-amber-500',
    items: [
      { id: 'users', label: '基础管理', icon: Users, color: 'text-indigo-400', bar: 'bg-indigo-500' },
      { id: 'org-structure', label: '组织架构', icon: Network, color: 'text-emerald-400', bar: 'bg-emerald-500' },
      { id: 'permission-approval', label: '权限审批', icon: ShieldCheck, color: 'text-amber-400', bar: 'bg-amber-500' },
    ],
  },
  {
    label: '治理与审核',
    icon: Scale,
    text: 'text-cyan-400',
    line: 'from-cyan-500 to-rose-500',
    items: [
      { id: 'rule-governance', label: '规则治理', icon: BookMarked, color: 'text-cyan-400', bar: 'bg-cyan-500' },
      { id: 'ai-audit', label: 'AI 审核', icon: Search, color: 'text-rose-400', bar: 'bg-rose-500' },
    ],
  },
  {
    label: '运维与系统',
    icon: Server,
    text: 'text-emerald-400',
    line: 'from-emerald-500 to-slate-500',
    items: [
      { id: 'quality-monitoring', label: '质量监控', icon: Gauge, color: 'text-emerald-400', bar: 'bg-emerald-500' },
      { id: 'patrol', label: '异常巡检', icon: Radar, color: 'text-orange-400', bar: 'bg-orange-500' },
      { id: 'system-config', label: '系统配置', icon: Settings, color: 'text-slate-300', bar: 'bg-slate-500' },
    ],
  },
];

/** 规则治理分类内的顶部 Tab（v0.9.56 起整合业务知识库与 SQL 样例库，五类治理资产统一入口） */
type RuleGovernanceTab = 'metrics' | 'iron-rules' | 'knowledge' | 'examples' | 'personas';

const RULE_TABS: SectionTabItem<RuleGovernanceTab>[] = [
  { id: 'metrics', label: '语义指标', icon: Ruler, color: 'text-cyan-400' },
  { id: 'iron-rules', label: '铁律规则', icon: ScrollText, color: 'text-rose-400' },
  { id: 'knowledge', label: '业务知识库', icon: BookOpen, color: 'text-amber-400' },
  { id: 'examples', label: 'SQL 样例库', icon: FileCode2, color: 'text-violet-400' },
  { id: 'personas', label: '专家角色', icon: UserCog, color: 'text-emerald-400' },
];

/** 质量监控分类内的顶部 Tab（v0.9.57：四张监控面板 Tab 分类，默认知识漂移保持提醒优先） */
type QualityTab = 'drift' | 'ops' | 'llm-usage' | 'ab-test';

const QUALITY_TABS: SectionTabItem<QualityTab>[] = [
  { id: 'drift', label: '知识漂移', icon: BellRing, color: 'text-amber-400' },
  { id: 'ops', label: '北极星指标', icon: Activity, color: 'text-emerald-400' },
  { id: 'llm-usage', label: 'Token 用量', icon: Coins, color: 'text-cyan-400' },
  { id: 'ab-test', label: 'A/B 实验', icon: TrendingUp, color: 'text-violet-400' },
];

/** 权限审批分类内的顶部 Tab（v0.9.57） */
type PermissionTab = 'access' | 'templates';

const PERMISSION_TABS: SectionTabItem<PermissionTab>[] = [
  { id: 'access', label: '访问审批', icon: ShieldCheck, color: 'text-amber-400' },
  { id: 'templates', label: '报告模板', icon: FileText, color: 'text-indigo-400' },
];

/** AI 审核分类内的顶部 Tab（v0.9.57） */
type AuditTab = 'fallback' | 'dlp';

const AUDIT_TABS: SectionTabItem<AuditTab>[] = [
  { id: 'fallback', label: 'Fallback 审核', icon: AlertTriangle, color: 'text-rose-400' },
  { id: 'dlp', label: '导出审批', icon: FileDown, color: 'text-cyan-400' },
];

export const AdminPanel: React.FC = () => {
  const currentUser = useAuthStore((s) => s.user);
  // v0.9.56 规则治理整合：知识库 / SQL 样例库面板需要数据源列表与当前数据源（登录后已由 App 加载）
  const dataSources = useAnalyticsStore((s) => s.dataSources);
  const activeDataSourceId = useAnalyticsStore((s) => s.activeDataSourceId);

  // 左栏分类切换：7 个分类（三域分组见 SECTION_GROUPS），默认「基础管理」
  const [section, setSection] = useState<AdminSection>('users');
  // 规则治理分类内顶部 Tab（v0.9.56）：语义指标 / 铁律规则 / 业务知识库 / SQL 样例库 / 专家角色
  const [ruleTab, setRuleTab] = useState<RuleGovernanceTab>('metrics');
  // 质量监控 / 权限审批 / AI 审核分类内顶部 Tab（v0.9.57）
  const [qualityTab, setQualityTab] = useState<QualityTab>('drift');
  const [permissionTab, setPermissionTab] = useState<PermissionTab>('access');
  const [auditTab, setAuditTab] = useState<AuditTab>('fallback');
  const contentRef = useRef<HTMLDivElement>(null);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // v0.9.66 组织架构树：组织架构面板、用户归属选择器与数据范围联动共用同一份节点数据
  const { units: orgUnits, loading: orgUnitsLoading, refresh: refreshOrgUnits } = useOrgUnits();

  // Create form
  const [isCreating, setIsCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newOrgUnitId, setNewOrgUnitId] = useState<number | null>(null);
  const [newRole, setNewRole] = useState<UserRole>('ANALYST');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 组织数据范围编辑（弹窗）：目标用户 + 档位 + 各维度取值（逗号分隔输入）
  const [scopeUser, setScopeUser] = useState<AdminUser | null>(null);
  const [scopeLevel, setScopeLevel] = useState<OrgScopeLevel>('ALL');
  const [scopeOrgs, setScopeOrgs] = useState('');
  const [scopeTeams, setScopeTeams] = useState('');
  const [scopeSelfCode, setScopeSelfCode] = useState('');
  const [isScopeSaving, setIsScopeSaving] = useState(false);
  // v0.9.66 数据范围「从组织树选择 / 手动填写」双模式（打开时按已有配置推断）与树选中节点
  const [scopeMode, setScopeMode] = useState<'tree' | 'manual'>('tree');
  const [scopeTreeIds, setScopeTreeIds] = useState<number[]>([]);
  // v0.9.66 组织归属设置弹窗（替换原 window.prompt 文本编辑）
  const [deptUser, setDeptUser] = useState<AdminUser | null>(null);
  const [deptDraftId, setDeptDraftId] = useState<number | null>(null);
  const [isDeptSaving, setIsDeptSaving] = useState(false);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 切换分类时将右栏内容区滚动回顶
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  // 初始 isLoading=true 覆盖首次加载；手动刷新时在按钮 onClick 里先 setIsLoading(true)
  const loadUsers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/users');
      const data = await res.json();
      if (data.success) {
        setUsers(data.users);
      } else {
        showNotice('error', data.error || '加载用户列表失败');
      }
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载用户列表失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => loadUsers(), 0);
    return () => clearTimeout(timer);
  }, [loadUsers]);

  // v0.9.68 新建用户校验：确认按钮禁用条件与服务端规则对齐（用户名格式 + 密码强度），并在字段下方给出原因
  const trimmedNewUsername = newUsername.trim();
  const usernameValid = USERNAME_PATTERN.test(trimmedNewUsername);
  const passwordCheck = checkPasswordStrength(newPassword, trimmedNewUsername);
  const canSubmitCreate = usernameValid && passwordCheck.ok;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername.trim(),
          displayName: newDisplayName.trim() || newUsername.trim(),
          password: newPassword,
          orgUnitId: newOrgUnitId,
          role: newRole,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '创建失败');
      showNotice('success', `用户 ${newUsername.trim()} 创建成功`);
      setIsCreating(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      setNewOrgUnitId(null);
      setNewRole('ANALYST');
      loadUsers();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleStatus = async (u: AdminUser) => {
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      showNotice('success', next === 'ACTIVE' ? `已启用 ${u.username}` : `已禁用 ${u.username}`);
      loadUsers();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  const handleResetPassword = async (u: AdminUser) => {
    const pwd = window.prompt(`为用户 ${u.username} 设置新密码（8-64 位，需包含字母和数字，重置后该用户下次登录需改密）:`);
    if (!pwd) return;
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: pwd }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '重置失败');
      showNotice('success', `已重置 ${u.username} 的密码`);
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  /** v0.9.66 打开组织归属设置弹窗：回填当前归属节点（未关联则为空） */
  const openDeptEditor = (u: AdminUser) => {
    setDeptUser(u);
    setDeptDraftId(u.orgUnitId ?? null);
  };

  /** 保存组织归属：orgUnitId=null 解除关联（服务端保留 department 旧文本供展示与 ACL 匹配） */
  const handleSaveDepartment = async () => {
    if (!deptUser || isDeptSaving) return;
    setIsDeptSaving(true);
    try {
      const res = await apiFetch(`/api/admin/users/${deptUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: deptDraftId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      const node = orgUnits.find((n) => n.id === deptDraftId);
      showNotice(
        'success',
        deptDraftId ? `已将 ${deptUser.username} 归属到「${node?.name ?? deptDraftId}」` : `已解除 ${deptUser.username} 的组织归属（部门文本保留）`
      );
      setDeptUser(null);
      loadUsers();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsDeptSaving(false);
    }
  };

  /** 打开数据范围编辑弹窗：按当前配置回填（树模式能表达时优先树，否则手动填写） */
  const openScopeEditor = (u: AdminUser) => {
    setScopeUser(u);
    setScopeLevel(u.orgScope?.level || 'ALL');
    setScopeOrgs((u.orgScope?.orgs || []).join(', '));
    setScopeTeams((u.orgScope?.teams || []).join(', '));
    setScopeSelfCode(u.orgScope?.selfCode || '');
    const inferred = inferScopeTreeSelection(u, orgUnits);
    setScopeTreeIds(inferred ?? []);
    setScopeMode(inferred ? 'tree' : 'manual');
  };

  const handleSaveScope = async () => {
    if (!scopeUser) return;
    let payload: UserOrgScope | null;
    if (scopeMode === 'tree') {
      // v0.9.66 树模式：选择节点自动生成档位与取值（机构与部门/团队混选拒绝）
      const derived = deriveScopeFromTree(scopeTreeIds, orgUnits);
      if (derived.error) {
        showNotice('error', derived.error);
        return;
      }
      payload = derived.payload ?? null;
    } else {
      const split = (s: string) => s.split(/[,\uFF0C\s]+/).map((v) => v.trim()).filter(Boolean);
      // 服务端会做完整校验（档位/非空/数量上限），此处仅防明显空值提交
      payload =
        scopeLevel === 'ALL'
          ? null
          : scopeLevel === 'ORG'
          ? { level: 'ORG', orgs: split(scopeOrgs) }
          : scopeLevel === 'TEAM'
          ? { level: 'TEAM', teams: split(scopeTeams) }
          : { level: 'SELF', selfCode: scopeSelfCode.trim() };
      if (payload && scopeLevel !== 'SELF' && !(payload.level === 'ORG' ? payload.orgs?.length : payload.teams?.length)) {
        showNotice('error', scopeLevel === 'ORG' ? '请填写机构编号' : '请填写团队名称');
        return;
      }
      if (payload && scopeLevel === 'SELF' && !payload.selfCode) {
        showNotice('error', '请填写经办人编号');
        return;
      }
    }
    setIsScopeSaving(true);
    try {
      const res = await apiFetch(`/api/admin/users/${scopeUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgScope: payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      showNotice('success', `已更新 ${scopeUser.username} 的数据范围为「${orgScopeText(payload)}」`);
      setScopeUser(null);
      loadUsers();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsScopeSaving(false);
    }
  };

  const handleDelete = async (u: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${u.username}（${u.displayName}）？此操作不可恢复。`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
      showNotice('success', `已删除用户 ${u.username}`);
      loadUsers();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  // v0.9.66 数据范围树模式的实时派生（档位 + 取值预览；混选等非法组合给出错误提示）
  const scopeTreeDerived = scopeMode === 'tree' && scopeUser ? deriveScopeFromTree(scopeTreeIds, orgUnits) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 紧凑页头 */}
      <div className="flex items-center space-x-3 px-6 py-4 border-b border-slate-800/60 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
          <ShieldCheck className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-base font-bold text-slate-100">系统管理</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            账号、治理、监控与系统配置的一体化管理控制台
          </p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 左栏分类导航（三域卡片分组：域图标 + 加粗标题 + 渐变延伸线，窄屏收窄为图标列；v0.9.58 升级） */}
        <nav className="w-14 md:w-52 shrink-0 border-r border-slate-800/60 overflow-y-auto p-2 md:p-3 space-y-2">
          {SECTION_GROUPS.map((group) => {
            const GroupIcon = group.icon;
            return (
              <div
                key={group.label}
                title={group.label}
                className="rounded-xl bg-slate-900/45 border border-slate-800/70 p-0.5 md:p-1.5"
              >
                {/* 分组标题：域图标 + 加粗说明文字 + 右侧渐变延伸线（窄屏隐藏，由卡片容器区分域） */}
                <div className="hidden md:flex items-center gap-1.5 pl-2 pr-1 pt-0.5 pb-1.5">
                  <GroupIcon className={`w-3.5 h-3.5 shrink-0 ${group.text}`} />
                  <span className="text-[11px] font-extrabold text-slate-200 tracking-wider whitespace-nowrap">{group.label}</span>
                  <span className={`flex-1 h-px min-w-2 bg-gradient-to-r ${group.line} opacity-40`} />
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = section === item.id;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSection(item.id)}
                        title={item.label}
                        className={`relative w-full flex items-center justify-center md:justify-start space-x-2 px-2 md:px-2.5 py-2 rounded-lg text-xs transition-colors ${
                          active
                            ? 'bg-slate-800/80 text-slate-100 font-semibold'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 font-medium'
                        }`}
                      >
                        {active && <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${item.bar}`} />}
                        <Icon className={`w-4 h-4 shrink-0 ${active ? item.color : ''}`} />
                        <span className="hidden md:inline">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* 右栏内容区（独立滚动，切换分类自动回顶） */}
        <div ref={contentRef} className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Notice */}
          {notice && (
            <div className={`p-4 rounded-xl border ${
              notice.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
            }`}>
              <div className="flex items-center gap-2">
                {notice.type === 'success' ? (
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                ) : (
                  <AlertCircle className="w-5 h-5 shrink-0" />
                )}
                <span>{notice.text}</span>
              </div>
            </div>
          )}

      {/* ============ 区块一：用户管理 ============ */}
      {section === 'users' && (
        <div className="space-y-6">
          {/* 创建账号表单 */}
          {isCreating && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center space-x-2 mb-6 pb-4 border-b border-slate-800">
                <UserPlus className="w-5 h-5 text-indigo-400" />
                <h3 className="text-lg font-bold text-slate-100">创建新账号</h3>
              </div>
      
              <form onSubmit={handleCreate}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">用户名 <span className="text-slate-500">(3-20 位字母/数字/下划线)</span></label>
                    <input
                      type="text"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder="zhangsan"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                    />
                    {newUsername && !usernameValid && (
                      <p className="text-[11px] text-rose-400">{USERNAME_HINT}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">显示名称</label>
                    <input
                      type="text"
                      value={newDisplayName}
                      onChange={(e) => setNewDisplayName(e.target.value)}
                      placeholder="张三"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">初始密码 <span className="text-slate-500">({PASSWORD_HINT})</span></label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="••••••"
                      autoComplete="new-password"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                    />
                    {newPassword && !passwordCheck.ok && (
                      <p className="text-[11px] text-rose-400">{passwordCheck.error}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">部门（组织节点）</label>
                    <OrgUnitPicker
                      units={orgUnits}
                      loading={orgUnitsLoading}
                      mode="single"
                      selectedIds={newOrgUnitId ? [newOrgUnitId] : []}
                      onChange={(ids) => setNewOrgUnitId(ids[0] ?? null)}
                      listClassName="max-h-32"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">角色</label>
                    <select
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value as UserRole)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    >
                      <option value="ANALYST">分析师</option>
                      <option value="VIEWER">只读用户</option>
                      <option value="ADMIN">管理员</option>
                    </select>
                  </div>
                </div>
      
                <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-slate-700"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || !canSubmitCreate}
                    className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-indigo-600/30 transition-all"
                  >
                    {isSubmitting ? '创建中…' : '确认创建'}
                  </button>
                </div>
              </form>
            </div>
          )}
      
          {/* 数据范围编辑弹窗（组织权限模型）：档位 + 取值；全辖 = 不限制 */}
          {scopeUser && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
              <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl">
                <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-indigo-400" />
                  <h3 className="text-base font-bold text-slate-100">配置数据范围 — {scopeUser.username}</h3>
                </div>
                <div className="p-6 space-y-4 text-xs">
                  {/* 配置方式切换（v0.9.66）：组织树选择（联动档位与取值）/ 手动填写（兼容存量） */}
                  <div className="flex gap-1 bg-slate-950 border border-slate-800 rounded-lg p-1">
                    <button
                      type="button"
                      onClick={() => setScopeMode('tree')}
                      className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        scopeMode === 'tree' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      从组织树选择
                    </button>
                    <button
                      type="button"
                      onClick={() => setScopeMode('manual')}
                      className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        scopeMode === 'manual' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      手动填写
                    </button>
                  </div>

                  {scopeMode === 'tree' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-slate-400 font-medium">
                          选择组织节点（可多选；总部 = 全辖不限制，机构 → 本机构，部门/团队 → 本项目团队）
                        </label>
                        <OrgUnitPicker
                          units={orgUnits}
                          loading={orgUnitsLoading}
                          mode="multi"
                          selectedIds={scopeTreeIds}
                          onChange={(ids) => setScopeTreeIds(ids)}
                          requireDataCode
                          listClassName="max-h-52"
                        />
                      </div>
                      {/* 实时值预览：保存前核对将写入 org_scope_json 的档位与取值 */}
                      <div
                        className={`rounded-lg p-3 border ${
                          scopeTreeDerived?.error ? 'bg-rose-500/5 border-rose-900/50' : 'bg-slate-950/60 border-slate-800'
                        }`}
                      >
                        <div className="text-slate-500 mb-1">将保存的数据范围：</div>
                        {scopeTreeDerived?.error ? (
                          <p className="text-rose-400">{scopeTreeDerived.error}</p>
                        ) : scopeTreeDerived?.payload ? (
                          <div className="space-y-0.5">
                            <div className="text-slate-300">档位：{SCOPE_LEVEL_LABELS[scopeTreeDerived.payload.level]}</div>
                            <code className="text-emerald-300 font-mono text-[11px] break-all">
                              {scopeTreeDerived.payload.level === 'ORG'
                                ? `orgs: ${JSON.stringify(scopeTreeDerived.payload.orgs)}`
                                : `teams: ${JSON.stringify(scopeTreeDerived.payload.teams)}`}
                            </code>
                          </div>
                        ) : (
                          <p className="text-slate-300">全辖（不限制）：不注入行过滤</p>
                        )}
                      </div>
                    </>
                  )}

                  {scopeMode === 'manual' && (
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">范围档位</label>
                    <select
                      value={scopeLevel}
                      onChange={(e) => setScopeLevel(e.target.value as OrgScopeLevel)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    >
                      {(Object.keys(SCOPE_LEVEL_LABELS) as OrgScopeLevel[]).map((lv) => (
                        <option key={lv} value={lv}>
                          {SCOPE_LEVEL_LABELS[lv]}
                        </option>
                      ))}
                    </select>
                  </div>
                  )}

                  {scopeMode === 'manual' && scopeLevel === 'ORG' && (
                    <div className="space-y-1.5">
                      <label className="text-slate-400 font-medium">机构编号（多个用逗号分隔，如 A01, A02）</label>
                      <input
                        type="text"
                        value={scopeOrgs}
                        onChange={(e) => setScopeOrgs(e.target.value)}
                        placeholder="A01, A02"
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                      />
                    </div>
                  )}

                  {scopeMode === 'manual' && scopeLevel === 'TEAM' && (
                    <div className="space-y-1.5">
                      <label className="text-slate-400 font-medium">团队名称（多个用逗号分隔，如 投资一部, 投资二部）</label>
                      <input
                        type="text"
                        value={scopeTeams}
                        onChange={(e) => setScopeTeams(e.target.value)}
                        placeholder="投资一部, 投资二部"
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    </div>
                  )}

                  {scopeMode === 'manual' && scopeLevel === 'SELF' && (
                    <div className="space-y-1.5">
                      <label className="text-slate-400 font-medium">经办人编号</label>
                      <input
                        type="text"
                        value={scopeSelfCode}
                        onChange={(e) => setScopeSelfCode(e.target.value)}
                        placeholder="U1001"
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                      />
                    </div>
                  )}

                  <p className="text-[11px] leading-relaxed text-slate-500 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                    问数与报表将在执行层按该范围自动注入行过滤（机构列 / 团队列 / 责任人列由「数据源与 Schema → 组织隔离」登记）。
                    未登记组织列的数据源不受影响；全辖档位等同不限制。
                  </p>
                </div>
                <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-3">
                  <button
                    onClick={() => setScopeUser(null)}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-slate-700"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveScope}
                    disabled={isScopeSaving || Boolean(scopeTreeDerived?.error)}
                    className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold shadow-lg shadow-indigo-600/30 transition-all"
                  >
                    {isScopeSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* v0.9.66 组织归属设置弹窗（替换原 window.prompt 文本编辑；部门文本由节点名派生） */}
          {deptUser && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
              <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl">
                <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                    <Network className="w-4 h-4 text-emerald-400" />
                    设置组织归属 — {deptUser.username}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setDeptUser(null)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-6 space-y-4 text-xs">
                  <p className="leading-relaxed text-slate-500 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                    当前部门文本：{deptUser.department || '未设置'}；
                    {deptUser.orgUnitId ? '已关联组织节点。' : '未关联组织节点。'}
                    选择节点后「部门」将取节点名称（数据源授权按该名称匹配）；再次点击已选节点可取消选择（解除关联保留当前部门文本）。
                  </p>
                  <OrgUnitPicker
                    units={orgUnits}
                    loading={orgUnitsLoading}
                    mode="single"
                    selectedIds={deptDraftId ? [deptDraftId] : []}
                    onChange={(ids) => setDeptDraftId(ids[0] ?? null)}
                    listClassName="max-h-64"
                  />
                </div>
                <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setDeptUser(null)}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-slate-700"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveDepartment()}
                    disabled={isDeptSaving}
                    className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold shadow-lg shadow-indigo-600/30 transition-all"
                  >
                    {isDeptSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 用户列表卡片 */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            {/* 卡片头部 */}
            <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Users className="w-5 h-5 text-indigo-400" />
                  系统账号列表
                </h3>
                <p className="text-xs text-slate-500 mt-1">共 {users.length} 个账号</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    placeholder="搜索用户..."
                    className="w-64 pl-10 pr-4 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  />
                </div>
                <button
                  onClick={() => setIsCreating((v) => !v)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-sm font-semibold shadow-lg shadow-indigo-600/30 transition-all group border border-indigo-500/50"
                >
                  <UserPlus className="w-4 h-4 group-hover:scale-110 transition-transform" />
                  <span>创建账号</span>
                </button>
              </div>
            </div>
      
            {/* 表格区域 */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-950">
                  <tr>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">用户名 / 显示名</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">部门</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">数据范围</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">角色</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">状态</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">最近登录</th>
                    <th className="px-6 py-3 text-right text-[10px] font-medium text-slate-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {isLoading ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center">
                        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
                        <p className="text-sm text-slate-500">加载中...</p>
                      </td>
                    </tr>
                  ) : users.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center">
                        <Users className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                        <p className="text-sm text-slate-500">暂无用户数据</p>
                      </td>
                    </tr>
                  ) : (
                    users.map((u) => {
                      const isSelf = u.id === currentUser?.id;
                      return (
                        <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white font-bold text-sm shrink-0 shadow-lg">
                                {u.displayName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="text-sm font-semibold text-slate-200">{u.username}</div>
                                  {isSelf && (
                                    <span className="text-[9px] text-indigo-300 bg-indigo-500/20 px-1.5 py-0.5 rounded border border-indigo-500/30">
                                      当前账号
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-500">{u.displayName}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-400">
                            <button
                              onClick={() => openDeptEditor(u)}
                              title="点击设置组织归属节点（部门文本由节点名派生）"
                              className="inline-flex items-center gap-1.5 hover:text-indigo-400 hover:underline transition-colors"
                            >
                              <span>{u.department || <span className="text-slate-600 italic">未设置</span>}</span>
                              {u.orgUnitId ? (
                                <Link2 className="w-3 h-3 text-emerald-400 shrink-0" />
                              ) : (
                                <span className="text-[9px] text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 shrink-0">
                                  未关联组织
                                </span>
                              )}
                            </button>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <button
                              onClick={() => openScopeEditor(u)}
                              title="点击配置数据范围（全辖/本机构/本项目团队/仅本人）"
                              className={`text-xs font-medium px-2 py-1 rounded-md border transition-colors hover:border-indigo-500/60 ${
                                u.orgScope ? 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30' : 'text-slate-500 border-slate-700/60'
                              }`}
                            >
                              {orgScopeText(u.orgScope)}
                            </button>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                              u.role === 'ADMIN'
                                ? 'bg-violet-500/10 text-violet-300 border-violet-500/30'
                                : u.role === 'ANALYST'
                                ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                                : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                            }`}>
                              {ROLE_LABELS[u.role]}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                              u.status === 'ACTIVE'
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                            }`}>
                              {u.status === 'ACTIVE' ? '启用中' : '已禁用'}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 font-mono">
                            {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleToggleStatus(u)}
                                disabled={isSelf}
                                title={isSelf ? '不能禁用当前登录账号' : ''}
                                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                  u.status === 'ACTIVE'
                                    ? 'border-rose-800/60 text-rose-400 hover:bg-rose-950/30'
                                    : 'border-emerald-800/60 text-emerald-400 hover:bg-emerald-950/30'
                                }`}
                              >
                                {u.status === 'ACTIVE' ? '禁用' : '启用'}
                              </button>
                              <button
                                onClick={() => handleResetPassword(u)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-300 text-xs font-medium transition-colors"
                              >
                                <KeyRound className="w-3 h-3" />
                                <span>重置</span>
                              </button>
                              <button
                                onClick={() => handleDelete(u)}
                                disabled={isSelf}
                                title={isSelf ? '不能删除当前登录账号' : ''}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-800/60 text-rose-400 hover:bg-rose-950/30 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Trash2 className="w-3 h-3" />
                                <span>删除</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      
      {/* ============ 区块一·补充：组织架构（v0.9.66 四级树维护：总部→机构→部门→团队） ============ */}
      {section === 'org-structure' && (
        <OrgStructurePanel units={orgUnits} loading={orgUnitsLoading} refresh={refreshOrgUnits} />
      )}

      {/* ============ 区块二：质量监控（v0.9.57 起四张监控面板顶部 Tab 分类：知识漂移 / 北极星指标 / Token 用量 / A/B 实验） ============ */}
      {section === 'quality-monitoring' && (
        <div className="space-y-6">
          <SectionTabs<QualityTab> tabs={QUALITY_TABS} active={qualityTab} onChange={setQualityTab} accent="emerald" />

          {/* P3-3 知识库漂移提醒（枚举值快照比对） */}
          {qualityTab === 'drift' && <DriftAlertPanel />}
          {/* P0-4 北极星运营指标 */}
          {qualityTab === 'ops' && <OpsMetricsPanel />}
          {/* LLM Token 用量（按用户/模型成本对比） */}
          {qualityTab === 'llm-usage' && <LlmUsagePanel />}
          {/* Fallback A/B 实验分析 */}
          {qualityTab === 'ab-test' && <ABTestDashboard />}
        </div>
      )}
      
      {/* ============ 区块三：规则治理（v0.9.56 起五类治理资产顶部 Tab 分类：语义指标 / 铁律规则 / 业务知识库 / SQL 样例库 / 专家角色） ============ */}
      {section === 'rule-governance' && (
        <div className="space-y-6">
          {/* 顶部 Tab 分类条（业务知识库与 SQL 样例库由「数据源与 Schema」迁入，统一治理入口） */}
          <SectionTabs<RuleGovernanceTab> tabs={RULE_TABS} active={ruleTab} onChange={setRuleTab} accent="cyan" />

          {/* 语义指标：指标层治理（P1-8 提议 - 审批 - 版本化） */}
          {ruleTab === 'metrics' && <MetricsPanel />}
          {/* 铁律规则：铁律规则库（v0.9.35 全量恒注入强制约束） */}
          {ruleTab === 'iron-rules' && <IronRulesPanel />}
          {/* 业务知识库：术语口径与外部知识源（v0.9.56 由数据源页迁入） */}
          {ruleTab === 'knowledge' && (
            <KnowledgeBasePanel dataSources={dataSources} initialId={activeDataSourceId} />
          )}
          {/* SQL 样例库：「问题-SQL」训练样例（v0.9.56 由数据源页迁入） */}
          {ruleTab === 'examples' && (
            <SqlExamplesPanel dataSources={dataSources} initialId={activeDataSourceId} />
          )}
          {/* 专家角色：问数专家角色（v0.9.40 阶段二解读 persona 路由配置） */}
          {ruleTab === 'personas' && <ExpertPersonasPanel />}
        </div>
      )}
      
      {/* ============ 区块四：权限审批（v0.9.57 起顶部 Tab 分类：访问审批 / 报告模板） ============ */}
      {section === 'permission-approval' && (
        <div className="space-y-5">
          <SectionTabs<PermissionTab> tabs={PERMISSION_TABS} active={permissionTab} onChange={setPermissionTab} accent="amber" />

          {/* 数据源权限审批（P2-11 申请 - 审批 - 授权） */}
          {permissionTab === 'access' && <AccessRequestsPanel />}
          {/* 报告模板管理（v0.5.0） */}
          {permissionTab === 'templates' && <ReportTemplateManager />}
        </div>
      )}
      
      {/* ============ 区块五：AI 审核（v0.9.57 起顶部 Tab 分类：Fallback 审核 / 导出审批） ============ */}
      {section === 'ai-audit' && (
        <div className="space-y-5">
          <SectionTabs<AuditTab> tabs={AUDIT_TABS} active={auditTab} onChange={setAuditTab} accent="rose" />

          {/* NL2SQL Fallback 困难样本审核（v0.9.44 Strategy C） */}
          {auditTab === 'fallback' && <FallbackApprovalPanel />}
          {/* P2-12 DLP 数据导出审批（超阈值下载申请） */}
          {auditTab === 'dlp' && <DlpDownloadPanel />}
        </div>
      )}
      
      {/* ============ 区块六：系统配置 (环境配置 + 系统设置) ============ */}
      {section === 'system-config' && <EnvironmentConfigPanel />}

      {/* ============ 区块七：异常巡检（v0.9.52 起为巡检唯一入口，由 PatrolPanel 承载） ============ */}
      {section === 'patrol' && <PatrolPanel />}
        </div>
      </div>
    </div>
  );
};
