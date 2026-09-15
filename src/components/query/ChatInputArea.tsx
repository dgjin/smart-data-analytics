import React from 'react';
import { Send, Sparkles, Search, ArrowUpRight, Mic, MicOff, Volume2, ShieldCheck } from 'lucide-react';
import { buildQueryPlaceholder } from '../../utils/querySuggestions';
import { QueryModeBar } from './QueryModeBar';
import { SkillMenuButton } from './SkillMenuButton';
import { ReportTemplate } from '../../types/analytics';
import { SkillItem } from './hooks/useSkillLibrary';
import { ModelOption } from '../../hooks/useModelCatalog';

// L1 输入层（与服务端 queryGuard.MAX_QUESTION_LENGTH 对齐）：单条提问最大 500 字
const MAX_QUERY_INPUT_LENGTH = 500;

interface ChatInputAreaProps {
  aiSwitchOff: boolean;
  canPlanMode: boolean;
  isQueryLoading: boolean;
  // 输入与建议
  currentQuery: string;
  setCurrentQuery: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  schemaSuggestions: string[];
  presetQueries: string[];
  filteredSuggestions: string[];
  isSuggestionsOpen: boolean;
  setIsSuggestionsOpen: (v: boolean) => void;
  selectedIndex: number;
  setSelectedIndex: (v: number) => void;
  onSendQuery: (queryText?: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  // 语音
  isListening: boolean;
  speechError: string | null;
  toggleSpeechRecognition: () => void;
  clearSpeechError: () => void;
  // 模式行
  planMode: boolean;
  onTogglePlanMode: () => void;
  agentMode: boolean;
  onToggleAgentMode: () => void;
  deepMode: boolean;
  onToggleDeepMode: () => void;
  reportMode: boolean;
  onToggleReportMode: () => void;
  reportTemplates: ReportTemplate[];
  selectedTemplateId: number | null;
  onSelectTemplate: (id: number | null) => void;
  modelCatalog: ModelOption[];
  selectedModel: string;
  onSelectModel: (v: string) => void;
  // 技能
  skills: SkillItem[];
  skillMenuOpen: boolean;
  onToggleSkillMenu: () => void;
  skillMenuRef: React.RefObject<HTMLDivElement | null>;
  onSelectSkill: (promptTemplate: string) => void;
  onOpenSkillLibrary: () => void;
}

/**
 * 问数输入区（P0 上帝组件拆分：自 QueryChat 提取的受控子组件）。
 * 含 AI 开关提示、快速问题推荐、自动补全下拉、语音输入横幅、模式选项行、
 * 技能「+」入口、主输入表单与字数计数。所有状态由父组件受控传入，本组件无副作用。
 */
export const ChatInputArea: React.FC<ChatInputAreaProps> = (props) => {
  const {
    aiSwitchOff,
    canPlanMode,
    isQueryLoading,
    currentQuery,
    setCurrentQuery,
    inputRef,
    schemaSuggestions,
    presetQueries,
    filteredSuggestions,
    isSuggestionsOpen,
    setIsSuggestionsOpen,
    selectedIndex,
    setSelectedIndex,
    onSendQuery,
    onKeyDown,
    isListening,
    speechError,
    toggleSpeechRecognition,
    clearSpeechError,
    planMode,
    onTogglePlanMode,
    agentMode,
    onToggleAgentMode,
    deepMode,
    onToggleDeepMode,
    reportMode,
    onToggleReportMode,
    reportTemplates,
    selectedTemplateId,
    onSelectTemplate,
    modelCatalog,
    selectedModel,
    onSelectModel,
    skills,
    skillMenuOpen,
    onToggleSkillMenu,
    skillMenuRef,
    onSelectSkill,
    onOpenSkillLibrary,
  } = props;

  return (
    <div className="p-3 md:p-4 bg-slate-900/90 border-t border-slate-800 shrink-0 space-y-2">
      {/* AI Switch Off Notice（L7 AI 开关） */}
      {aiSwitchOff && (
        <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex items-center space-x-2">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>该数据源的智能问数功能已被管理员停用，可在「数据源管理」中重新连接启用。</span>
        </div>
      )}

      {/* Quick Prompt Pills */}
      {presetQueries.length > 0 && !aiSwitchOff && (
        <div className="flex items-center space-x-2 overflow-x-auto pb-1 text-xs">
          <span className="text-slate-400 font-medium shrink-0 flex items-center space-x-1">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>快速问题推荐:</span>
          </span>
          {presetQueries.map((pq, idx) => (
            <button
              key={idx}
              onClick={() => onSendQuery(pq)}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700/80 text-slate-300 hover:text-slate-100 border border-slate-700 rounded-lg shrink-0 transition-colors"
            >
              {pq}
            </button>
          ))}
        </div>
      )}

      {/* Main Input Form with Autocomplete Dropdown */}
      <div className="relative">
        {/* Autocomplete Suggestions Popup */}
        {isSuggestionsOpen && filteredSuggestions.length > 0 && (
          <div className="absolute bottom-full mb-2 left-0 right-0 bg-slate-900 border border-indigo-500/30 rounded-2xl p-2.5 shadow-2xl z-50 space-y-1">
            <div className="flex items-center justify-between px-2.5 py-1 border-b border-slate-800 text-[10px] text-slate-400">
              <span className="flex items-center space-x-1 text-indigo-400 font-semibold">
                <Search className="w-3 h-3" />
                <span>实时查询推荐与 Schema 提示 ({filteredSuggestions.length})</span>
              </span>
              <span className="text-slate-500 font-mono hidden sm:inline">
                ↑↓ 切换 | Enter 选择 | Tab 补全 | Esc 关闭
              </span>
            </div>

            <div className="max-h-56 overflow-y-auto space-y-0.5">
              {filteredSuggestions.map((suggestion, idx) => {
                const isSelected = selectedIndex === idx;
                return (
                  <div
                    key={idx}
                    onClick={() => onSendQuery(suggestion)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-indigo-600 text-white font-medium shadow-sm'
                        : 'text-slate-200 hover:bg-slate-800/80'
                    }`}
                  >
                    <div className="flex items-center space-x-2.5 truncate">
                      <Sparkles className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-white' : 'text-indigo-400'}`} />
                      <span className="truncate">{suggestion}</span>
                    </div>

                    <div className="flex items-center space-x-1 text-[10px] opacity-80 shrink-0">
                      <span className="hidden md:inline font-mono">点击直接查询</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Voice Listening Banner */}
        {isListening && (
          <div className="mb-2 p-2.5 rounded-xl bg-rose-950/60 border border-rose-500/50 flex items-center justify-between text-xs text-rose-200 animate-pulse">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></span>
              <Volume2 className="w-4 h-4 text-rose-400" />
              <span className="font-semibold">正在语音实时录音识别中，请说话...</span>
            </div>
            <button
              onClick={toggleSpeechRecognition}
              className="px-2 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-[10px] font-bold"
            >
              停止录音
            </button>
          </div>
        )}

        {speechError && (
          <div className="mb-2 p-2 rounded-xl bg-amber-950/60 border border-amber-500/40 text-amber-300 text-xs flex items-center justify-between">
            <span>{speechError}</span>
            <button
              onClick={clearSpeechError}
              className="text-amber-400 text-[10px] underline ml-2"
            >
              关闭
            </button>
          </div>
        )}

        {/* 模式选项行：P0-1 拆至 QueryModeBar（计划/深度/报告模式 + 金额单位 + 模型自选） */}
        <QueryModeBar
          aiSwitchOff={aiSwitchOff}
          canPlanMode={canPlanMode}
          planMode={planMode}
          onTogglePlanMode={onTogglePlanMode}
          agentMode={agentMode}
          onToggleAgentMode={onToggleAgentMode}
          deepMode={deepMode}
          onToggleDeepMode={onToggleDeepMode}
          reportMode={reportMode}
          onToggleReportMode={onToggleReportMode}
          reportTemplates={reportTemplates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={onSelectTemplate}
          isQueryLoading={isQueryLoading}
          modelCatalog={modelCatalog}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSendQuery();
          }}
          className="flex items-center space-x-2"
        >
          {/* P2-A 技能「+」入口：P0-1 拆至 SkillMenuButton（选中技能填充提问模板） */}
          <SkillMenuButton
            aiSwitchOff={aiSwitchOff}
            skills={skills}
            menuOpen={skillMenuOpen}
            onToggleMenu={onToggleSkillMenu}
            menuRef={skillMenuRef}
            onSelectSkill={onSelectSkill}
            onOpenLibrary={onOpenSkillLibrary}
          />

          <div className="relative flex-1 flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={currentQuery}
              onChange={(e) => setCurrentQuery(e.target.value)}
              onFocus={() => {
                if (currentQuery.trim() && filteredSuggestions.length > 0) {
                  setIsSuggestionsOpen(true);
                }
              }}
              onKeyDown={onKeyDown}
              placeholder={
                aiSwitchOff
                  ? '该数据源的问数功能已停用'
                  : buildQueryPlaceholder(schemaSuggestions, '用自然语言提问（或点击右侧麦克风语音输入）...')
              }
              maxLength={MAX_QUERY_INPUT_LENGTH}
              disabled={isQueryLoading || aiSwitchOff}
              className={`w-full bg-slate-950 border rounded-xl pl-4 pr-10 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                isListening
                  ? 'border-rose-500 shadow-md shadow-rose-500/20'
                  : 'border-slate-700/80 focus:border-indigo-500'
              }`}
            />

            {/* Voice Input Mic Button */}
            <button
              type="button"
              onClick={toggleSpeechRecognition}
              title={isListening ? '点击停止语音输入' : '开启语音转文字输入'}
              className={`absolute right-2.5 p-1.5 rounded-lg transition-all ${
                isListening
                  ? 'bg-rose-600 text-white animate-pulse'
                  : 'text-slate-400 hover:text-indigo-400 hover:bg-slate-800'
              }`}
            >
              {isListening ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>
          </div>

          <button
            type="submit"
            disabled={!currentQuery.trim() || isQueryLoading || aiSwitchOff}
            className="px-5 py-3 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-xs flex items-center space-x-1.5 shadow-lg shadow-indigo-600/30 transition-all shrink-0"
          >
            <Send className="w-4 h-4" />
            <span>智能查询</span>
          </button>
        </form>

        {/* Input Length Counter（L1：接近 500 字上限时提示） */}
        {currentQuery.length >= MAX_QUERY_INPUT_LENGTH - 50 && (
          <div className={`mt-1.5 text-right text-[10px] font-mono ${
            currentQuery.length >= MAX_QUERY_INPUT_LENGTH ? 'text-rose-400' : 'text-amber-400'
          }`}>
            {currentQuery.length}/{MAX_QUERY_INPUT_LENGTH}
          </div>
        )}
      </div>
    </div>
  );
};
