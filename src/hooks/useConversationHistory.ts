/**
 * P1-6 QueryChat 拆分：对话历史管理 hook（服务端落库）。
 * 搜索 / 重问回填 / 单条删除 / Markdown 导出；面板打开期间切换数据源自动重拉。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import { ChatMessage } from '../types/analytics';
import { buildConversationMarkdown, downloadMarkdownFile } from '../utils/conversationExport';

export interface ConversationItem {
  id: number;
  question: string;
  sql: string;
  answerSummary: string;
  status: 'SUCCESS' | 'FALLBACK';
  provenance: string;
  createdAt: string;
}

export interface ConversationHistory {
  historyOpen: boolean;
  historyItems: ConversationItem[];
  historyLoading: boolean;
  historyKeyword: string;
  setHistoryKeyword: (kw: string) => void;
  toggleHistoryPanel: () => void;
  loadHistory: (keyword: string) => Promise<void>;
  handleDeleteConversation: (id: number) => Promise<void>;
  handleExportConversation: () => void;
}

interface HistoryDeps {
  activeDataSourceId: string;
  /** 当前数据源可见对话（导出范围） */
  visibleMessages: ChatMessage[];
  /** 数据源清单（导出文件名取当前源名称） */
  dataSources: { id: string; name: string }[];
  showToast: (message: string) => void;
}

export function useConversationHistory(deps: HistoryDeps): ConversationHistory {
  const { activeDataSourceId, visibleMessages, dataSources, showToast } = deps;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<ConversationItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyKeyword, setHistoryKeyword] = useState('');

  const loadHistory = useCallback(
    async (keyword: string) => {
      if (!activeDataSourceId) return;
      setHistoryLoading(true);
      try {
        const params = new URLSearchParams({ dataSourceId: activeDataSourceId });
        if (keyword.trim()) params.set('q', keyword.trim());
        const resp = await apiFetch(`/api/conversations?${params.toString()}`);
        const data = await resp.json();
        setHistoryItems(resp.ok && Array.isArray(data?.conversations) ? data.conversations : []);
      } catch {
        setHistoryItems([]);
        showToast('对话历史加载失败');
      } finally {
        setHistoryLoading(false);
      }
    },
    [activeDataSourceId]
  );

  const toggleHistoryPanel = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) {
      setHistoryKeyword('');
      void loadHistory('');
    }
  };

  // 面板打开期间切换数据源：自动重新拉取对应源的历史
  useEffect(() => {
    if (historyOpen) {
      if (activeDataSourceId) void loadHistory(historyKeyword);
      else setHistoryItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDataSourceId]);

  const handleDeleteConversation = async (id: number) => {
    try {
      const resp = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (resp.ok) {
        setHistoryItems((prev) => prev.filter((it) => it.id !== id));
        showToast('已删除该条对话记录');
      } else {
        const data = await resp.json().catch(() => ({}));
        showToast(data?.error || '删除失败');
      }
    } catch {
      showToast('删除失败');
    }
  };

  // 导出当前数据源的对话为 Markdown（问题 + 回答 + SQL）
  const handleExportConversation = () => {
    if (visibleMessages.length === 0) {
      showToast('当前数据源暂无可导出的对话');
      return;
    }
    const dsName = dataSources.find((ds) => ds.id === activeDataSourceId)?.name || '未知数据源';
    downloadMarkdownFile(buildConversationMarkdown(visibleMessages, dsName), dsName);
    showToast('已开始导出对话 Markdown');
  };

  return {
    historyOpen,
    historyItems,
    historyLoading,
    historyKeyword,
    setHistoryKeyword,
    toggleHistoryPanel,
    loadHistory,
    handleDeleteConversation,
    handleExportConversation,
  };
}
