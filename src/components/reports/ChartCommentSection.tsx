import React, { useState } from 'react';
import {
  MessageSquare,
  Send,
  User,
  CheckCircle,
  CornerDownRight,
  Sparkles,
  PlusCircle,
  MessageCircle,
  Tag,
  Clock,
  Check,
} from 'lucide-react';
import { ChartComment, ChartCommentReply } from '../../types/analytics';

interface ChartCommentSectionProps {
  reportId: string;
  chartTitle: string;
  availableDataPoints?: string[];
  comments: ChartComment[];
  onAddComment: (comment: ChartComment) => void;
  onAddReply: (commentId: string, reply: ChartCommentReply) => void;
  onToggleResolve: (commentId: string) => void;
}

export const ChartCommentSection: React.FC<ChartCommentSectionProps> = ({
  reportId,
  chartTitle,
  availableDataPoints = [],
  comments,
  onAddComment,
  onAddReply,
  onToggleResolve,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<string>(availableDataPoints[0] || '整体图表趋势');
  const [newCommentText, setNewCommentText] = useState('');
  const [currentUserRole, setCurrentUserRole] = useState<'数据分析师' | '运营总监' | '首席执行官' | '财务主管'>('数据分析师');

  // Reply state
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  const activeComments = comments.filter((c) => c.chartTitle === chartTitle);
  const unresolvedCount = activeComments.filter((c) => !c.isResolved).length;

  const handleCreateComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentText.trim()) return;

    const newComment: ChartComment = {
      id: `cmt-${Date.now()}`,
      reportId,
      chartTitle,
      dataPointKey: selectedPoint,
      userName: currentUserRole === '首席执行官' ? '张总 (CEO)' : currentUserRole === '运营总监' ? '李总监 (运营)' : currentUserRole === '财务主管' ? '王主管 (财务)' : '陈分析师 (BI)',
      userRole: currentUserRole,
      content: newCommentText.trim(),
      createdAt: '刚刚',
      isResolved: false,
      replies: [],
    };

    onAddComment(newComment);
    setNewCommentText('');
    setIsAddingNew(false);
  };

  const handleCreateReply = (commentId: string) => {
    if (!replyText.trim()) return;

    const reply: ChartCommentReply = {
      id: `rpl-${Date.now()}`,
      userName: currentUserRole === '首席执行官' ? '张总 (CEO)' : currentUserRole === '运营总监' ? '李总监 (运营)' : currentUserRole === '财务主管' ? '王主管 (财务)' : '陈分析师 (BI)',
      userRole: currentUserRole,
      content: replyText.trim(),
      createdAt: '刚刚',
    };

    onAddReply(commentId, reply);
    setReplyText('');
    setReplyingToId(null);
  };

  return (
    <div className="border-t border-slate-800/80 pt-3 mt-2">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center space-x-2 text-xs font-bold text-slate-300 hover:text-indigo-400 transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
          <span>图表协同批注讨论区 ({activeComments.length})</span>
          {unresolvedCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-indigo-600 text-white text-[10px]">
              {unresolvedCount} 未解决
            </span>
          )}
        </button>

        <button
          onClick={() => {
            setIsOpen(true);
            setIsAddingNew(!isAddingNew);
          }}
          className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-bold flex items-center space-x-1 transition-all"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>添加图表批注</span>
        </button>
      </div>

      {isOpen && (
        <div className="mt-3 space-y-3 bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5">
          {/* Role switcher simulation */}
          <div className="flex items-center justify-between text-[10px] text-slate-400 border-b border-slate-800/80 pb-2">
            <span className="flex items-center space-x-1">
              <Sparkles className="w-3 h-3 text-cyan-400" />
              <span>协同身份 (当前):</span>
            </span>
            <div className="flex items-center space-x-1">
              {(['数据分析师', '运营总监', '财务主管', '首席执行官'] as const).map((role) => (
                <button
                  key={role}
                  onClick={() => setCurrentUserRole(role)}
                  className={`px-2 py-0.5 rounded font-medium transition-colors ${
                    currentUserRole === role
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {role}
                </button>
              ))}
            </div>
          </div>

          {/* New Comment Input Form */}
          {isAddingNew && (
            <form onSubmit={handleCreateComment} className="space-y-2.5 bg-slate-950 p-3 rounded-xl border border-indigo-500/30">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-indigo-300 flex items-center space-x-1">
                  <Tag className="w-3.5 h-3.5 text-indigo-400" />
                  <span>针对数据点 / 波动项发起批注</span>
                </span>
                {availableDataPoints.length > 0 && (
                  <select
                    value={selectedPoint}
                    onChange={(e) => setSelectedPoint(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-200 px-2 py-1 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="整体图表趋势">整体图表趋势</option>
                    {availableDataPoints.map((pt, i) => (
                      <option key={i} value={pt}>
                        数据点: {pt}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <textarea
                value={newCommentText}
                onChange={(e) => setNewCommentText(e.target.value)}
                placeholder="输入协同批注观点、业务原因解读或改进建议（例如：6月大促归因于市场营销冲量投放...）"
                rows={2}
                className="w-full bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />

              <div className="flex items-center justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsAddingNew(false)}
                  className="px-3 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!newCommentText.trim()}
                  className="px-3.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center space-x-1"
                >
                  <Send className="w-3 h-3" />
                  <span>发布批注</span>
                </button>
              </div>
            </form>
          )}

          {/* Comment List */}
          {activeComments.length === 0 ? (
            <div className="text-center py-4 text-xs text-slate-500">
              暂无图表批注。点击上方的“添加图表批注”开始团队协同讨论。
            </div>
          ) : (
            <div className="space-y-3">
              {activeComments.map((comment) => (
                <div
                  key={comment.id}
                  className={`p-3 rounded-xl border text-xs space-y-2 transition-all ${
                    comment.isResolved
                      ? 'bg-slate-950/40 border-slate-800 opacity-60'
                      : 'bg-slate-950 border-slate-800'
                  }`}
                >
                  {/* Comment Author Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-6 h-6 rounded-full bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 flex items-center justify-center text-[10px] font-bold">
                        {comment.userName.charAt(0)}
                      </div>
                      <div>
                        <span className="font-bold text-slate-200">{comment.userName}</span>
                        <span className="text-[10px] text-slate-500 ml-1.5 font-mono">
                          {comment.createdAt}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2">
                      {comment.dataPointKey && (
                        <span className="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-500/30 text-[10px]">
                          标注: {comment.dataPointKey}
                        </span>
                      )}

                      <button
                        onClick={() => onToggleResolve(comment.id)}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center space-x-1 ${
                          comment.isResolved
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : 'bg-slate-800 text-slate-400 hover:text-emerald-400'
                        }`}
                      >
                        <Check className="w-3 h-3" />
                        <span>{comment.isResolved ? '已解决' : '标记解决'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Comment Body */}
                  <p className="text-slate-300 leading-relaxed pl-8">
                    {comment.content}
                  </p>

                  {/* Replies List */}
                  {comment.replies && comment.replies.length > 0 && (
                    <div className="pl-8 space-y-2 pt-1 border-t border-slate-800/60">
                      {comment.replies.map((reply) => (
                        <div key={reply.id} className="p-2 rounded-lg bg-slate-900 border border-slate-800/80 text-[11px] space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-indigo-300 flex items-center space-x-1">
                              <CornerDownRight className="w-3 h-3 text-slate-500" />
                              <span>{reply.userName}</span>
                            </span>
                            <span className="text-[9px] text-slate-500">{reply.createdAt}</span>
                          </div>
                          <p className="text-slate-300 pl-4">{reply.content}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Inline Reply Trigger */}
                  <div className="pl-8 pt-1 flex items-center justify-between">
                    <button
                      onClick={() => setReplyingToId(replyingToId === comment.id ? null : comment.id)}
                      className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 flex items-center space-x-1"
                    >
                      <MessageCircle className="w-3 h-3" />
                      <span>{replyingToId === comment.id ? '取消回复' : '回复讨论'}</span>
                    </button>
                  </div>

                  {/* Reply Form */}
                  {replyingToId === comment.id && (
                    <div className="pl-8 pt-2 flex items-center space-x-2">
                      <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={`回复 ${comment.userName}...`}
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleCreateReply(comment.id);
                          }
                        }}
                      />
                      <button
                        onClick={() => handleCreateReply(comment.id)}
                        disabled={!replyText.trim()}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold rounded-lg text-xs"
                      >
                        回复
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
