// P0-1 拆分：技能「+」入口（参照 Qoder IDE「+」交互）——点击向上弹出技能选择面板，
// 选中后将提问模板填入输入框；含技能库管理入口
import React from 'react';
import { ArrowUpRight, Library, Plus, Sparkles } from 'lucide-react';

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
}

export interface SkillMenuButtonProps {
  /** L7 AI 开关：数据源被停用或无可用技能时入口隐藏 */
  aiSwitchOff: boolean;
  skills: SkillItem[];
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** 点击面板外部自动关闭所用的容器 ref */
  menuRef: React.RefObject<HTMLDivElement | null>;
  onSelectSkill: (promptTemplate: string) => void;
  onOpenLibrary: () => void;
}

export const SkillMenuButton: React.FC<SkillMenuButtonProps> = ({
  aiSwitchOff,
  skills,
  menuOpen,
  onToggleMenu,
  menuRef,
  onSelectSkill,
  onOpenLibrary,
}) => {
  if (aiSwitchOff || skills.length === 0) return null;
  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={onToggleMenu}
        title="添加分析技能（选择后将提问模板填入输入框）"
        className={`px-3.5 py-3 rounded-xl border text-sm transition-colors ${
          menuOpen
            ? 'bg-cyan-950/60 border-cyan-500 text-cyan-300'
            : 'bg-slate-950 border-slate-700/80 text-slate-400 hover:border-cyan-500/60 hover:text-cyan-300'
        }`}
      >
        <Plus className="w-4 h-4" />
      </button>
      {menuOpen && (
        <div className="absolute left-0 bottom-full mb-2 w-80 max-w-[86vw] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center space-x-1.5">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-[11px] font-semibold text-cyan-300">分析技能 ({skills.length})</span>
            <span className="text-[10px] text-slate-500">· 点击填充提问模板</span>
          </div>
          <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800/60">
            {skills.map((sk) => (
              <li key={sk.id}>
                <button
                  type="button"
                  title={`点击将「${sk.name}」的提问模板填入输入框`}
                  onClick={() => onSelectSkill(sk.promptTemplate)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-800/60 transition-colors group"
                >
                  <div className="flex items-center space-x-2 min-w-0">
                    <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-300 shrink-0">{sk.name}</span>
                    <span className="text-[10px] text-slate-500 truncate flex-1">{sk.description}</span>
                    <ArrowUpRight className="w-3 h-3 text-slate-600 group-hover:text-cyan-400 shrink-0" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-800">
            <button
              type="button"
              title="管理我的技能库与系统技能库"
              onClick={onOpenLibrary}
              className="w-full text-left px-3 py-2 text-[11px] text-indigo-300 hover:bg-slate-800/60 transition-colors flex items-center space-x-1.5"
            >
              <Library className="w-3 h-3" />
              <span>技能库管理</span>
            </button>
          </div>
        </div>
      )}
    </div>

  );
};
