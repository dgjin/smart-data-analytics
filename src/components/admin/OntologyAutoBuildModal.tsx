import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles, X, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronRight, Boxes, Tag, GitBranch, Layers3 } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import { useEscapeKey } from './ontologyUi';

/**
 * 业务本体「智能预填」弹窗（v0.9.112）：
 * 基于数据源 Schema 的中文列描述与命名规则生成本体草案，先预览再一键应用。
 * 已存在的实体 / 值域 / 关联 / 层级默认跳过，不会覆盖人工维护内容。
 */

interface DraftBinding {
  tableName: string;
  columnName: string;
  role: 'IDENTITY' | 'ATTRIBUTE' | 'RELATION_KEY';
}

export interface AutoBuildDraft {
  entities: {
    name: string;
    entityType: string;
    aliases: string[];
    description: string;
    bindings: DraftBinding[];
    reasons: string[];
  }[];
  valueNotes: { tableName: string; columnName: string; valueCode: string; meaning: string; reason: string }[];
  relations: {
    fromTable: string;
    fromColumns: string[];
    toTable: string;
    toColumns: string[];
    joinType: string;
    cardinality: string;
    purpose: string;
    reason: string;
  }[];
  hierarchies: { name: string; levels: string[]; reason: string }[];
  skipped: string[];
  stats: { tables: number; columns: number; entities: number; bindings: number; valueNotes: number; relations: number; hierarchies: number };
}

export interface AutoBuildApplied {
  entitiesCreated: number;
  entitiesUpdated: number;
  bindingsWritten: number;
  valueNotesWritten: number;
  relationsCreated: number;
  hierarchiesCreated: number;
  skippedExisting: number;
  errors: string[];
}

interface Props {
  dataSourceId: string;
  dataSourceName: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onClose: () => void;
  onApplied: () => void;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string })?.error;
    throw new Error(msg || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

const PREVIEW_LIMIT = 8;

const ROLE_LABEL: Record<string, string> = { IDENTITY: '标识', ATTRIBUTE: '属性', RELATION_KEY: '关联键' };

export const OntologyAutoBuildModal: React.FC<Props> = ({ dataSourceId, dataSourceName, showNotice, onClose, onApplied }) => {
  const [draft, setDraft] = useState<AutoBuildDraft | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<AutoBuildApplied | null>(null);
  // 预览默认全展开，便于一次性复核四类资产
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    entities: true,
    valueNotes: true,
    relations: true,
    hierarchies: true,
  });

  useEscapeKey(!applying, onClose);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError('');
    try {
      const data = await postJson<{ draft: AutoBuildDraft }>('/api/ontology/auto-build', { dataSourceId });
      setDraft(data.draft);
    } catch (err) {
      setLoadError(getErrorMessage(err) || '生成草案失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const apply = async () => {
    if (!draft) return;
    setApplying(true);
    try {
      const data = await postJson<{ applied: AutoBuildApplied }>('/api/ontology/auto-build', { dataSourceId, apply: true });
      setApplied(data.applied);
      const a = data.applied;
      showNotice(
        'success',
        `智能预填完成：新增实体 ${a.entitiesCreated}、绑定 ${a.bindingsWritten}、值域 ${a.valueNotesWritten}、关联 ${a.relationsCreated}、层级 ${a.hierarchiesCreated}；跳过已存在 ${a.skippedExisting} 项`
      );
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '应用失败');
    } finally {
      setApplying(false);
    }
  };

  const totalItems = draft
    ? draft.stats.entities + draft.stats.valueNotes + draft.stats.relations + draft.stats.hierarchies
    : 0;

  const stats: { label: string; value: number; cls: string }[] = draft
    ? [
        { label: '业务实体', value: draft.stats.entities, cls: 'text-cyan-300' },
        { label: '表列绑定', value: draft.stats.bindings, cls: 'text-slate-200' },
        { label: '值域释义', value: draft.stats.valueNotes, cls: 'text-amber-300' },
        { label: '关联路径', value: draft.stats.relations, cls: 'text-emerald-300' },
        { label: '业务层级', value: draft.stats.hierarchies, cls: 'text-violet-300' },
      ]
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => !applying && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="智能预填业务本体"
        className="w-full max-w-4xl max-h-[86vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              智能预填
              <span className="text-[10px] font-normal text-slate-500">基于 Schema 描述推断 · 先预览再应用</span>
            </div>
            <div className="text-xs text-slate-400">
              数据源：{dataSourceName || dataSourceId}
              {draft && <> · {draft.stats.tables} 张表 / {draft.stats.columns} 列</>}
            </div>
          </div>
          <button onClick={onClose} disabled={applying} aria-label="关闭智能预填" className="text-slate-400 hover:text-slate-200 disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" /> 正在分析 Schema 并生成本体草案…
            </div>
          )}

          {!isLoading && loadError && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <AlertCircle className="w-4 h-4 shrink-0" /> {loadError}
            </div>
          )}

          {!isLoading && draft && !applied && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {stats.map((s) => (
                  <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                    <div className={`text-lg font-bold ${s.cls}`}>{s.value}</div>
                    <div className="text-[10px] text-slate-500">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-[11px] text-cyan-100/80">
                应用时按业务键幂等写入：同名实体、同键值域、同方向关联与同名层级默认跳过，不会覆盖人工维护内容；所有写入均留版本快照，可在「版本」中回滚。
              </div>

              <Section
                icon={<Boxes className="w-3.5 h-3.5 text-cyan-400" />}
                title="业务实体与绑定"
                count={draft.entities.length}
                open={Boolean(expanded.entities)}
                onToggle={() => toggle('entities')}
              >
                {draft.entities.slice(0, PREVIEW_LIMIT).map((e) => (
                  <div key={e.name} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-200">
                      <span className="font-bold">{e.name}</span>
                      <span className="text-[10px] text-slate-500">{e.entityType}</span>
                      {e.aliases.length > 0 && <span className="text-[10px] text-slate-500">别名：{e.aliases.join('、')}</span>}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      绑定 {e.bindings.length} 条：
                      {e.bindings
                        .slice(0, 4)
                        .map((b) => `${b.tableName}.${b.columnName || '(表级)'}(${ROLE_LABEL[b.role] || b.role})`)
                        .join('、')}
                      {e.bindings.length > 4 ? ' …' : ''}
                    </div>
                  </div>
                ))}
                {draft.entities.length > PREVIEW_LIMIT && (
                  <div className="text-[10px] text-slate-500">还有 {draft.entities.length - PREVIEW_LIMIT} 个实体，应用后可在「实体与绑定」查看</div>
                )}
              </Section>

              <Section
                icon={<Tag className="w-3.5 h-3.5 text-amber-400" />}
                title="值域释义"
                count={draft.valueNotes.length}
                open={Boolean(expanded.valueNotes)}
                onToggle={() => toggle('valueNotes')}
              >
                {draft.valueNotes.slice(0, PREVIEW_LIMIT).map((v, i) => (
                  <div key={`${v.tableName}.${v.columnName}.${v.valueCode}.${i}`} className="text-[11px] text-slate-300">
                    <span className="text-slate-500">{v.tableName}.{v.columnName}</span> · {v.valueCode} → {v.meaning}
                  </div>
                ))}
                {draft.valueNotes.length > PREVIEW_LIMIT && (
                  <div className="text-[10px] text-slate-500">还有 {draft.valueNotes.length - PREVIEW_LIMIT} 条值域释义</div>
                )}
              </Section>

              <Section
                icon={<GitBranch className="w-3.5 h-3.5 text-emerald-400" />}
                title="关联路径"
                count={draft.relations.length}
                open={Boolean(expanded.relations)}
                onToggle={() => toggle('relations')}
              >
                {draft.relations.slice(0, PREVIEW_LIMIT).map((r, i) => (
                  <div key={`${r.fromTable}.${r.toTable}.${i}`} className="text-[11px] text-slate-300">
                    <span className="text-slate-400">{r.fromTable}</span>({r.fromColumns.join(',')}) →{' '}
                    <span className="text-slate-400">{r.toTable}</span>({r.toColumns.join(',')}) · {r.joinType} · {r.cardinality}
                    <div className="text-[10px] text-slate-500">{r.purpose}</div>
                  </div>
                ))}
                {draft.relations.length === 0 && <div className="text-[10px] text-slate-500">未发现跨表同名列，可应用后手动登记</div>}
              </Section>

              <Section
                icon={<Layers3 className="w-3.5 h-3.5 text-violet-400" />}
                title="业务层级"
                count={draft.hierarchies.length}
                open={Boolean(expanded.hierarchies)}
                onToggle={() => toggle('hierarchies')}
              >
                {draft.hierarchies.map((h) => (
                  <div key={h.name} className="text-[11px] text-slate-300">
                    <span className="font-medium">{h.name}</span>
                    <span className="text-slate-500">：{h.levels.join(' > ')}</span>
                  </div>
                ))}
                {draft.hierarchies.length === 0 && <div className="text-[10px] text-slate-500">未识别到分级列族，可应用后手动新建</div>}
              </Section>

              {draft.skipped.length > 0 && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 space-y-1">
                  <div className="text-[11px] font-medium text-amber-200">未自动生成的项（可手动补充）</div>
                  {draft.skipped.map((s, i) => (
                    <div key={i} className="text-[10px] text-amber-100/70">· {s}</div>
                  ))}
                </div>
              )}
            </>
          )}

          {!isLoading && applied && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                <CheckCircle2 className="w-4 h-4 shrink-0" /> 已应用到数据源「{dataSourceName || dataSourceId}」
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {[
                  ['新增实体', applied.entitiesCreated],
                  ['更新实体', applied.entitiesUpdated],
                  ['写入绑定', applied.bindingsWritten],
                  ['值域释义', applied.valueNotesWritten],
                  ['关联路径', applied.relationsCreated],
                  ['业务层级', applied.hierarchiesCreated],
                  ['跳过已存在', applied.skippedExisting],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                    <div className="text-base font-bold text-slate-200">{String(value)}</div>
                    <div className="text-[10px] text-slate-500">{label}</div>
                  </div>
                ))}
              </div>
              {applied.errors.length > 0 && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 space-y-1">
                  <div className="text-[11px] text-rose-200">部分写入失败</div>
                  {applied.errors.slice(0, 5).map((e, i) => (
                    <div key={i} className="text-[10px] text-rose-100/80">· {e}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-800">
          <div className="text-[10px] text-slate-500">
            {applied ? '可在各子页签继续微调，或查看版本快照回滚' : `共 ${totalItems} 项候选；预览确认后再写入`}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={applying} className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-50">
              {applied ? '关闭' : '取消'}
            </button>
            {applied ? (
              <button
                onClick={() => {
                  onApplied();
                  onClose();
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30"
              >
                完成并刷新
              </button>
            ) : (
              <button
                onClick={() => void apply()}
                disabled={applying || isLoading || Boolean(loadError) || totalItems === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50"
              >
                {applying && <Loader2 className="w-3 h-3 animate-spin" />}
                {applying ? '应用中…' : `应用 ${totalItems} 项`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const Section: React.FC<{ icon: React.ReactNode; title: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }> = ({
  icon,
  title,
  count,
  open,
  onToggle,
  children,
}) => (
  <div className="rounded-xl border border-slate-800">
    <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-3 py-2 text-xs text-slate-200 hover:bg-slate-800/40">
      <span className="flex items-center gap-2">
        {icon}
        {title}
        <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{count}</span>
      </span>
      {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
    </button>
    {open && <div className="space-y-1.5 px-3 pb-3">{children}</div>}
  </div>
);

export default OntologyAutoBuildModal;
