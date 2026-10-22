/**
 * 业务本体面板共享表单控件（v0.9.111 易用性优化）：
 * - 表/列输入带当前数据源 Schema 联想，未命中时黄色提示（只提示、不阻断保存）；
 * - 多列输入支持「已选列 chips + 下拉快速插入」，避免手敲逗号拼接；
 * - 层级编辑器统一创建 / 编辑体验（增删 + 上下移 + 预览）；
 * - Esc 关闭弹层。所有控件保持受控，值仍是字符串，接口契约不变。
 */
import React from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { TableSchema } from '../../types/analytics';
import type { OntologyAccent } from './ontologyHelpers';
import { columnsOf, listFromText } from './ontologyHelpers';

const FOCUS_BORDER: Record<OntologyAccent, string> = {
  cyan: 'focus:border-cyan-500',
  amber: 'focus:border-amber-500',
  emerald: 'focus:border-emerald-500',
  violet: 'focus:border-violet-500',
};

const ACTIVE_CHIP: Record<OntologyAccent, string> = {
  cyan: 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200',
  amber: 'border-amber-500/50 bg-amber-500/15 text-amber-200',
  emerald: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200',
  violet: 'border-violet-500/50 bg-violet-500/15 text-violet-200',
};

interface SchemaInputProps {
  kind: 'table' | 'column';
  value: string;
  onChange: (next: string) => void;
  tables: TableSchema[];
  /** kind=column 时依赖的表名（用于取列建议；为空则不校验列） */
  tableName?: string;
  listId: string;
  placeholder?: string;
  accent?: OntologyAccent;
  className?: string;
  ariaLabel?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * 表名 / 列名输入：datalist 联想 + 未命中 Schema 的行内提示。
 * 不阻断保存——登记库外表/列仍允许（执行层白名单独立校验）。
 */
export const SchemaInput: React.FC<SchemaInputProps> = ({
  kind,
  value,
  onChange,
  tables,
  tableName = '',
  listId,
  placeholder,
  accent = 'cyan',
  className = 'w-full',
  ariaLabel,
  onKeyDown,
}) => {
  const options = kind === 'table' ? tables.map((t) => t.name) : columnsOf(tables, tableName);
  const trimmed = value.trim();
  const canValidate = kind === 'table' || tableName.trim() !== '';
  const matched = trimmed === '' || options.some((o) => o.toLowerCase() === trimmed.toLowerCase());
  const showWarn = canValidate && trimmed !== '' && !matched;
  const warnText = kind === 'table'
    ? '未在当前数据源 Schema 中找到该表，保存后执行期不会命中'
    : '未在该表结构中找到该列，保存后执行期不会命中';

  return (
    <div className="space-y-0.5">
      <div className="relative">
        <input
          list={listId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={`${className} bg-slate-950 border rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none ${FOCUS_BORDER[accent]} ${
            showWarn ? 'border-amber-500/60 pr-6' : 'border-slate-700'
          }`}
        />
        {showWarn && (
          <AlertTriangle className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-amber-400" />
        )}
        <datalist id={listId}>
          {options.map((o) => <option key={o} value={o} />)}
        </datalist>
      </div>
      {showWarn && <div className="text-[10px] leading-tight text-amber-400/90">{warnText}</div>}
    </div>
  );
};

interface SchemaColumnsInputProps {
  value: string;
  onChange: (next: string) => void;
  tables: TableSchema[];
  tableName: string;
  listId: string;
  placeholder?: string;
  accent?: OntologyAccent;
  ariaLabel?: string;
}

/**
 * 多列输入（逗号分隔）+ 已选列 chips + 下拉追加。
 * 用于关联路径的两侧关联列：点击已选 chip 可移除，下拉可追加表中其余列。
 */
export const SchemaColumnsInput: React.FC<SchemaColumnsInputProps> = ({
  value,
  onChange,
  tables,
  tableName,
  listId,
  placeholder,
  accent = 'emerald',
  ariaLabel,
}) => {
  const selected = listFromText(value);
  const available = columnsOf(tables, tableName).filter((c) => !selected.includes(c));
  const write = (cols: string[]) => onChange(cols.join(','));

  return (
    <div className="space-y-1">
      <SchemaInput
        kind="column"
        value={value}
        onChange={onChange}
        tables={tables}
        tableName={tableName}
        listId={listId}
        placeholder={placeholder}
        accent={accent}
        ariaLabel={ariaLabel}
      />
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {selected.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => write(selected.filter((x) => x !== c))}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${ACTIVE_CHIP[accent]}`}
              title="点击移除该列"
            >
              <span>{c}</span>
              <span className="text-[9px] opacity-70">×</span>
            </button>
          ))}
        </div>
      )}
      {available.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const col = e.target.value;
            if (col) write([...selected, col]);
          }}
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-slate-400 focus:outline-none focus:border-slate-500"
          aria-label="从表结构追加关联列"
        >
          <option value="">＋ 从表结构追加列（{available.length} 可选）</option>
          {available.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
    </div>
  );
};

interface LevelEditorProps {
  levels: string[];
  onChange: (next: string[]) => void;
  /** 可选列名建议（业务层级通常取自同一张维度表的列） */
  columnOptions?: string[];
  listId: string;
  accent?: OntologyAccent;
}

/** 业务层级编辑器：逐级输入 + 上下移 + 增删 + 先后顺序预览 */
export const LevelEditor: React.FC<LevelEditorProps> = ({
  levels,
  onChange,
  columnOptions = [],
  listId,
  accent = 'violet',
}) => {
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= levels.length) return;
    const next = [...levels];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {levels.map((lv, i) => (
        <div key={i} className="flex items-center space-x-1.5">
          <span className="w-5 shrink-0 text-center text-[10px] text-slate-500">{i + 1}</span>
          <input
            list={listId}
            value={lv}
            onChange={(e) => {
              const next = [...levels];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder={`第 ${i + 1} 级，如 ${i === 0 ? '集团' : i === 1 ? '分公司' : '项目'}`}
            aria-label={`第 ${i + 1} 级层级`}
            className={`flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none ${FOCUS_BORDER[accent]}`}
          />
          <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded-lg text-slate-400 hover:bg-slate-800 disabled:opacity-30" title="上移">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => move(i, 1)} disabled={i === levels.length - 1} className="p-1 rounded-lg text-slate-400 hover:bg-slate-800 disabled:opacity-30" title="下移">
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onChange(levels.filter((_, j) => j !== i))}
            disabled={levels.length <= 2}
            className="p-1 rounded-lg text-rose-300 hover:bg-rose-950/40 disabled:opacity-30"
            title={levels.length <= 2 ? '至少保留两级' : '移除该级'}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange([...levels, ''])}
          className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px]"
        >
          <Plus className="w-3 h-3" /><span>添加层级</span>
        </button>
        <span className="text-[10px] text-slate-500">
          预览：{levels.map((s) => s.trim()).filter(Boolean).join(' > ') || '（待填写）'}
        </span>
      </div>
      {columnOptions.length > 0 && (
        <datalist id={listId}>
          {columnOptions.map((c) => <option key={c} value={c} />)}
        </datalist>
      )}
    </div>
  );
};
