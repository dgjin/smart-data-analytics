import { useState } from 'react';

// M2 计划模式持久化键（'1' = 开启「先制定计划」）
const PLAN_MODE_KEY = 'app-plan-mode';
// P1-7 Agent 编排持久化键（'1' = 开启「Agent 编排」，与计划模式互斥）
const AGENT_MODE_KEY = 'app-agent-mode';
// M3 深度分析持久化键（'1' = 强制启用中间表清洗链）
const DEEP_ANALYSIS_KEY = 'app-deep-analysis';
// v0.5.0 报告模式持久化键
const REPORT_MODE_KEY = 'app-report-mode';

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeFlag = (key: string, on: boolean): void => {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // 存储不可用时仅本次会话生效
  }
};

/**
 * 问数模式开关集合（P0 上帝组件拆分：自 QueryChat 提取，行为保持一致）。
 * 收敛 planMode / agentMode / deepMode / reportMode 四个开关及其 localStorage 持久化；
 * 计划模式与 Agent 编排互斥（开启一个自动关闭另一个）。
 */
export function useQueryModes() {
  // M2 计划模式：「先制定计划」开关（localStorage 持久化）
  const [planMode, setPlanMode] = useState<boolean>(() => readFlag(PLAN_MODE_KEY));
  // P1-7 Agent 编排：「提问→规划多能力步骤→批准→逐步执行」开关（与计划模式互斥）
  const [agentMode, setAgentMode] = useState<boolean>(() => readFlag(AGENT_MODE_KEY));
  // M3 深度分析：强制启用中间表清洗链（关闭时由服务端复杂度评估自动判定）
  const [deepMode, setDeepMode] = useState<boolean>(() => readFlag(DEEP_ANALYSIS_KEY));
  // v0.5.0 报告模式：开启后提问直接生成完整报告（支持模板选择或智能推断）
  const [reportMode, setReportMode] = useState<boolean>(() => readFlag(REPORT_MODE_KEY));

  const togglePlanMode = () => {
    setPlanMode((prev) => {
      const next = !prev;
      writeFlag(PLAN_MODE_KEY, next);
      return next;
    });
    // P1-7：计划模式与 Agent 编排互斥，开启本模式时关闭另一个
    setAgentMode(false);
    writeFlag(AGENT_MODE_KEY, false);
  };

  const toggleAgentMode = () => {
    setAgentMode((prev) => {
      const next = !prev;
      writeFlag(AGENT_MODE_KEY, next);
      return next;
    });
    setPlanMode(false);
    writeFlag(PLAN_MODE_KEY, false);
  };

  const toggleDeepMode = () => {
    setDeepMode((prev) => {
      const next = !prev;
      writeFlag(DEEP_ANALYSIS_KEY, next);
      return next;
    });
  };

  const toggleReportMode = () => {
    setReportMode((prev) => {
      const next = !prev;
      writeFlag(REPORT_MODE_KEY, next);
      return next;
    });
  };

  return {
    planMode,
    togglePlanMode,
    agentMode,
    toggleAgentMode,
    deepMode,
    toggleDeepMode,
    reportMode,
    toggleReportMode,
  };
}
