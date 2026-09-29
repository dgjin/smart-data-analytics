/**
 * 系统帮助路由：实时读取 docs/核心文档 下帮助文档并返回给前端渲染。
 * - GET /manual：用户使用指南（面向终端用户回答「系统怎么用」），缺失时回退《系统功能说明书》；
 * - GET /changelog：更新日志（按版本记录主要更新内容，供用户备查，v0.9.36）；
 * - POST /ask：帮助中心「智能问答」（v0.9.88）——基于帮助文档章节检索 + LLM 快速作答。
 * 文档读取与问答业务分别下沉到 server/help/helpDocs.ts 与 server/help/helpAsk.ts，
 * 与既有路由惯例一致：路由层仅做参数校验、限流与鉴权装配。
 */
import { Router } from 'express';
import { authMiddleware } from '../auth/auth';
import { rateLimiter } from '../infra/rateLimiter';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';
import { CHANGELOG_FILENAME, candidatePathsFor, readDoc, readManual } from '../help/helpDocs';
import { MAX_QUESTION_CHARS, answerHelpQuestion, normalizeHelpHistory } from '../help/helpAsk';

const router = Router();

// GET /api/help/manual —— 返回功能说明书 Markdown 与最后更新时间
router.get('/manual', authMiddleware, (_req, res) => {
  const manual = readManual();
  if (!manual) {
    return res.status(404).json({ error: '使用指南文件不存在，请联系管理员' });
  }
  return res.json(manual);
});

// GET /api/help/changelog —— 返回更新日志 Markdown 与最后更新时间（v0.9.36）
router.get('/changelog', authMiddleware, (_req, res) => {
  const changelog = readDoc(candidatePathsFor(CHANGELOG_FILENAME));
  if (!changelog) {
    return res.status(404).json({ error: '更新日志文件不存在，请联系管理员' });
  }
  return res.json(changelog);
});

// POST /api/help/ask —— 帮助中心「智能问答」（v0.9.88）：{question, history?} → {answer, sections}
// 登录用户即可使用（不限角色）；挂限流防 LLM 调用被高频滥用
router.post('/ask', rateLimiter, authMiddleware, async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'question 必填' });
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: `问题过长（不超过 ${MAX_QUESTION_CHARS} 字）` });
    }
    const result = await answerHelpQuestion(question, normalizeHelpHistory(req.body?.history));
    return res.json(result);
  } catch (err) {
    logger.error(`[help] 智能问答失败: ${getErrorMessage(err)}`);
    return res.status(502).json({ error: 'AI 回答失败，请稍后重试；或切换到「使用指南」页签查阅文档' });
  }
});

export default router;
