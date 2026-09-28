// v0.9.79 灵活查询图形化增强：表关系画布。
// v0.9.80 字段图形化升级：字段片（类型色块图标 + 主键/已使用徽章 + 悬停快捷筛选），
// 连接符悬停/编辑时联动高亮两侧关联字段片，JOIN 类型按 INNER 靛蓝 / LEFT 琥珀着色，表头染色并展示行数/字段数。
// 数据表以卡片图形化展现，字段可直接拖到下方查询配置区拼装 SQL；
// 「表库」中的表拖入画布即建立 JOIN 关联（addJoinByTable 内部按字段名启发式预填条件）；
// 卡间连接符可视化 JOIN 关系，可切换 INNER/LEFT、点击编辑关联字段、移除。与行式 JoinConfigPanel 共享同一 joins 状态。
import React, { useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Filter,
  GripVertical,
  Hash,
  Key,
  Link2,
  Network,
  Table2,
  ToggleLeft,
  Trash2,
  Type,
} from 'lucide-react';
import { ColumnSchema, TableSchema } from '../../types/analytics';
import { FlexJoin } from '../../utils/flexQueryBuilder';
import { matchFieldSearch } from '../../utils/pinyin';
import { DropZone } from './flexQueryShared';

/** 拖表入画布的自定义 MIME（与字段拖拽的 text/plain 区分：字段经过画布不触发关联 drop） */
export const FLEX_TABLE_MIME = 'application/x-flex-table';

export interface TableGraphCanvasProps {
  tables: TableSchema[];
  tableSchema: TableSchema | undefined;
  selectedTable: string;
  joins: FlexJoin[];
  setJoins: React.Dispatch<React.SetStateAction<FlexJoin[]>>;
  usedColumns: Set<string>;
  fieldSearch: string;
  addField: (column: string, zone?: DropZone) => void;
  /** 拖表/点表建立关联（校验 + 猜字段 + 提示在 useFlexQueryState 中集中处理） */
  addJoinByTable: (table: string) => void;
}

/** 归一化列类型 → 图形徽标（icon + 颜色 + 底色块 + 无障碍标签，未知类型回退文本样式） */
const TYPE_SPECS: Record<ColumnSchema['type'], { icon: typeof Type; cls: string; chip: string; label: string }> = {
  string: { icon: Type, cls: 'text-slate-400', chip: 'bg-slate-500/15', label: '文本' },
  category: { icon: Type, cls: 'text-sky-400', chip: 'bg-sky-500/15', label: '分类' },
  number: { icon: Hash, cls: 'text-emerald-400', chip: 'bg-emerald-500/15', label: '数值' },
  date: { icon: CalendarDays, cls: 'text-cyan-400', chip: 'bg-cyan-500/15', label: '日期' },
  boolean: { icon: ToggleLeft, cls: 'text-violet-400', chip: 'bg-violet-500/15', label: '布尔' },
};

export const TableGraphCanvas: React.FC<TableGraphCanvasProps> = ({
  tables,
  tableSchema,
  selectedTable,
  joins,
  setJoins,
  usedColumns,
  fieldSearch,
  addField,
  addJoinByTable,
}) => {
  const [open, setOpen] = useState(true);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  // v0.9.80：连接符悬停/编辑联动高亮两侧字段片（null = 无联动）
  const [hoverJoin, setHoverJoin] = useState<number | null>(null);
  // 表库 chip 拖拽中标记（仅驱动空态提示文案；落点判定以 dataTransfer.types 为准，
  // 避免拖表成功时 chip 被卸载导致 dragend 不触发、状态残留拦截后续拖拽）
  const [draggingTable, setDraggingTable] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  if (!tableSchema) return null;

  const joinTableOf = (name: string) => tables.find((t) => t.name === name);
  const shelves = tables.filter((t) => t.name !== selectedTable && !joins.some((j) => j.table === t.name));

  const patchJoin = (idx: number, patch: Partial<FlexJoin>) =>
    setJoins((prev) => prev.map((j, i) => (i === idx ? { ...j, ...patch } : j)));
  const removeJoin = (idx: number) => {
    setEditIdx(null);
    setHoverJoin(null);
    setJoins((prev) => prev.filter((_, i) => i !== idx));
  };
  /** 联动中的关联索引：编辑态优先于悬停态（两侧关联字段片据此高亮） */
  const activeJoinIdx = editIdx !== null ? editIdx : hoverJoin;

  /** 卡片字段片（主表 fullName 不带前缀 / 关联表带 table. 前缀，与 allFields/usedColumns 同口径）：
   *  类型色块图标 + 主键/已使用徽章；悬停显示快捷筛选按钮；连接符联动时整体高亮 */
  const fieldRows = (tableName: string, main: boolean) => {
    const table = main ? tableSchema : joinTableOf(tableName);
    const cols = (table?.columns || []).filter((c) => matchFieldSearch(fieldSearch, c.name, c.description || ''));
    if (cols.length === 0) return <p className="text-[10px] text-slate-600 px-2 py-1">无匹配字段</p>;
    return cols.map((c) => {
      const fullName = main ? c.name : `${tableName}.${c.name}`;
      const used = usedColumns.has(fullName);
      const spec = TYPE_SPECS[c.type] || TYPE_SPECS.string;
      const Icon = spec.icon;
      // 连接符联动：主表看 on.left，关联表看 on.right（activeJoinIdx 为编辑/悬停中的关联）
      const linked =
        activeJoinIdx !== null &&
        (main
          ? joins[activeJoinIdx]?.on.left === c.name
          : joins[activeJoinIdx]?.table === tableName && joins[activeJoinIdx]?.on.right === c.name);
      // 快捷筛选落位与字段面板行式列表一致：数值 → HAVING / 其余 → WHERE
      const filterZone: DropZone = c.type === 'number' ? 'having' : 'filter';
      return (
        <div
          key={c.name}
          data-testid={`flex-field-${fullName}`}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/plain', fullName)}
          onClick={() => addField(fullName)}
          title={`${fullName}${c.description ? ` · ${c.description}` : ''}（拖至下方查询配置区拼装 SQL；点击快速添加；悬停字段可加筛选）`}
          className={`group flex items-center gap-1 px-1 py-1 rounded-lg border cursor-grab text-[10.5px] leading-none transition-colors ${
            linked
              ? 'border-indigo-400/70 bg-indigo-500/15 text-indigo-100'
              : `border-transparent hover:border-slate-600/70 hover:bg-slate-800/80 ${used ? 'text-cyan-300' : 'text-slate-300'}`
          }`}
        >
          <span className={`w-4 h-4 rounded-md flex items-center justify-center shrink-0 ${spec.chip}`}>
            <Icon className={`w-2.5 h-2.5 ${spec.cls}`} aria-label={spec.label} />
          </span>
          <span className="truncate flex-1">{c.description || c.name}</span>
          {c.isPrimaryKey && (
            <span className="shrink-0 flex items-center rounded-md bg-amber-500/15 p-0.5" title="主键">
              <Key className="w-2.5 h-2.5 text-amber-400" aria-label="主键" />
            </span>
          )}
          {used && (
            <span className="shrink-0 flex items-center rounded-full bg-cyan-500/20 p-0.5" title="已使用">
              <Check className="w-2.5 h-2.5 text-cyan-400" aria-label="已使用" />
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); addField(fullName, filterZone); }}
            title={filterZone === 'having' ? '添加为 HAVING 指标过滤' : '添加为筛选条件'}
            className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded hover:bg-amber-500/20"
          >
            <Filter className={`w-2.5 h-2.5 ${filterZone === 'having' ? 'text-fuchsia-400' : 'text-amber-400'}`} />
          </button>
          <GripVertical className="w-2.5 h-2.5 text-slate-600 opacity-0 group-hover:opacity-100 shrink-0" />
        </div>
      );
    });
  };

  return (
    <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-2.5 space-y-2" data-testid="flexquery-table-graph">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-slate-400 uppercase flex items-center space-x-1">
          <Network className="w-3 h-3 text-indigo-400" />
          <span>表关系画布（拖字段拼装 SQL；拖表入画布建立关联）</span>
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起画布' : '展开画布'}
          className="text-slate-400 hover:text-slate-200"
        >
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {open && (
        <>
          {/* 表库：未加入画布的表（拖入画布或点击即建立关联） */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-slate-500 shrink-0">表库（拖入画布或点击建立关联）：</span>
            {shelves.length === 0 ? (
              <span className="text-[10px] text-slate-600">其余表均已加入画布</span>
            ) : (
              shelves.map((t) => (
                <button
                  key={t.id}
                  draggable
                  onDragStart={(e) => {
                    setDraggingTable(t.name);
                    e.dataTransfer.setData(FLEX_TABLE_MIME, t.name);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={() => {
                    setDraggingTable(null);
                    setDropHover(false);
                  }}
                  onClick={() => addJoinByTable(t.name)}
                  title={`拖入画布或点击添加关联：${t.displayName || t.name}`}
                  className="flex items-center space-x-1 px-1.5 py-0.5 rounded-lg border border-slate-700 bg-slate-900 text-[10px] text-slate-300 hover:border-indigo-500 hover:text-indigo-200 cursor-grab"
                >
                  <Table2 className="w-2.5 h-2.5 text-indigo-400" />
                  <span>{t.displayName || t.name}</span>
                  <span className="text-[9px] text-slate-500">{t.rowCount.toLocaleString()} 行</span>
                </button>
              ))
            )}
          </div>

          {/* 画布：主表卡片 → 连接符 → 关联表卡片链（横向滚动） */}
          <div
            data-testid="flexquery-graph-canvas"
            onDragOver={(e) => {
              // 仅携带表 MIME 的拖拽允许落点（字段拖拽 text/plain 经过画布不拦截、不高亮）
              if (!e.dataTransfer.types.includes(FLEX_TABLE_MIME)) return;
              e.preventDefault();
              setDropHover(true);
            }}
            onDragLeave={() => setDropHover(false)}
            onDrop={(e) => {
              e.preventDefault();
              // 落库即清空拖拽态：chip 卸载后 dragend 不再触发，不清理会残留空态文案
              setDraggingTable(null);
              setDropHover(false);
              const name = e.dataTransfer.getData(FLEX_TABLE_MIME);
              if (name) addJoinByTable(name);
            }}
            className={`flex items-stretch gap-2 overflow-x-auto pb-1.5 rounded-xl border-2 border-dashed p-2 transition-colors ${
              dropHover ? 'border-indigo-400 bg-indigo-950/30' : 'border-slate-700/60'
            }`}
          >
            {/* 主表卡片 */}
            <div className="w-[230px] shrink-0 rounded-xl border border-indigo-500/40 bg-slate-900/80 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-2 py-1 border-b border-slate-700/60 bg-indigo-500/10">
                <div className="flex items-center space-x-1 min-w-0">
                  <Table2 className="w-3 h-3 text-indigo-400 shrink-0" />
                  <span className="text-[11px] font-bold text-slate-100 truncate">
                    {tableSchema.displayName || tableSchema.name}
                  </span>
                  <span className="text-[9px] px-1 rounded bg-indigo-600/40 text-indigo-200 shrink-0">主表</span>
                </div>
                <span className="text-[9px] text-slate-500 shrink-0">
                  {tableSchema.rowCount.toLocaleString()} 行 · {tableSchema.columns.length} 字段
                </span>
              </div>
              <div className="max-h-[240px] overflow-y-auto p-1 space-y-0.5">{fieldRows(selectedTable, true)}</div>
            </div>

            {joins.map((j, idx) => {
              const jt = joinTableOf(j.table);
              return (
                <React.Fragment key={`${j.table}-${idx}`}>
                  {/* 连接符：JOIN 类型 + 关联条件（点击编辑）+ 移除；悬停/编辑联动高亮两侧字段片 */}
                  <div
                    data-testid="flex-join-connector"
                    onMouseEnter={() => setHoverJoin(idx)}
                    onMouseLeave={() => setHoverJoin(null)}
                    className="w-[172px] shrink-0 flex flex-col items-center justify-center gap-1 px-0.5"
                  >
                    <div className="flex items-center w-full">
                      <span className={`flex-1 border-t-2 border-dashed ${j.type === 'LEFT' ? 'border-amber-500/60' : 'border-indigo-500/60'}`} />
                      <select
                        value={j.type}
                        onChange={(e) => patchJoin(idx, { type: e.target.value as FlexJoin['type'] })}
                        title="JOIN 类型"
                        className="mx-0.5 bg-slate-800 border border-slate-700 rounded px-0.5 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                      >
                        <option value="INNER">INNER</option>
                        <option value="LEFT">LEFT</option>
                      </select>
                      <span className={`flex-1 border-t-2 border-dashed ${j.type === 'LEFT' ? 'border-amber-500/60' : 'border-indigo-500/60'}`} />
                    </div>
                    {editIdx === idx ? (
                      <div className="w-full space-y-0.5">
                        <select
                          value={j.on.left}
                          onChange={(e) => patchJoin(idx, { on: { ...j.on, left: e.target.value } })}
                          title="主表侧关联字段"
                          className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                        >
                          <option value="">主表侧字段…</option>
                          {tableSchema.columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.description || c.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={j.on.right}
                          onChange={(e) => patchJoin(idx, { on: { ...j.on, right: e.target.value } })}
                          title="关联表侧关联字段"
                          disabled={!jt}
                          className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none disabled:opacity-50"
                        >
                          <option value="">关联表侧字段…</option>
                          {(jt?.columns || []).map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.description || c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => setEditIdx(null)}
                          className="w-full text-[9px] text-slate-400 hover:text-slate-200"
                        >
                          完成
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditIdx(idx)}
                        title="点击编辑关联字段"
                        className="max-w-full text-[9px] font-mono text-indigo-300 hover:text-indigo-200 truncate"
                      >
                        ON {j.on.left || '?'} = {j.on.right || '?'}
                      </button>
                    )}
                    <button
                      onClick={() => removeJoin(idx)}
                      className="flex items-center space-x-0.5 text-[9px] text-slate-500 hover:text-rose-400"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                      <span>移除</span>
                    </button>
                  </div>

                  {/* 关联表卡片 */}
                  <div className="w-[230px] shrink-0 rounded-xl border border-slate-700 bg-slate-900/80 flex flex-col overflow-hidden">
                    <div className="flex items-center justify-between px-2 py-1 border-b border-slate-700/60 bg-cyan-500/10">
                      <div className="flex items-center space-x-1 min-w-0">
                        <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />
                        <span className="text-[11px] font-bold text-slate-100 truncate">{jt?.displayName || j.table}</span>
                      </div>
                      <span className="text-[9px] text-slate-500 shrink-0">
                        {jt ? `${jt.rowCount.toLocaleString()} 行 · ${jt.columns.length} 字段` : ''}
                      </span>
                    </div>
                    <div className="max-h-[240px] overflow-y-auto p-1 space-y-0.5">
                      {jt ? (
                        fieldRows(j.table, false)
                      ) : (
                        <p className="text-[10px] text-rose-400 px-2 py-1">关联表不存在于当前数据源</p>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}

            {/* 空态占位 / 拖拽落点提示（无关联表时） */}
            {joins.length === 0 && (
              <div
                className={`w-[172px] shrink-0 flex items-center justify-center rounded-xl border-2 border-dashed px-2 text-center text-[10px] ${
                  dropHover ? 'border-indigo-400 text-indigo-300' : 'border-slate-700/70 text-slate-600'
                }`}
              >
                {draggingTable ? '松开即添加为关联表' : '把表库中的表拖到此处建立关联'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
