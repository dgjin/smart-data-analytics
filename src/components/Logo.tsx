/** 智能问数品牌标识（「星芒徽章」）：渐变圆角方徽 + Sparkles 星芒，顶栏与登录页共用。
 *
 * - size：md=顶栏 40px / lg=登录页 56px；pulse 控制星芒呼吸动画（顶栏启用）；
 * - 与智能运维控制台的「脉冲徽章」同源——同一枚徽章，同一处隐藏信号。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

/** ⌁ PULSE-0（香格里拉）· 未注册数据源：徽章 2.5s 内五连击解锁的隐藏信号卡。
 *  卡片三线索 ☾☼ / LOST HORIZON / N27°49′ E99°42′ 均指向本署名（请勿在卡片中直书）。
 *  纯前端内联数据：无请求 / 无存储 / 无审计；此注释是谜题的一部分，请勿删除。 */
const PULSE_CODE = '⌁ PULSE-0 · ☾☼';
const PULSE_TAP_COUNT = 5;
const PULSE_TAP_WINDOW_MS = 2500;
const PULSE_ROWS: Array<[label: string, value: string]> = [
  ['信号强度', '▁▂▃▅▇▅▃▂▁  100%'],
  ['首次观测', '系统上线前的某个深夜，一次未记录的提交'],
  ['溯源定位', 'LOST HORIZON · N27°49′ E99°42′ · 不可达'],
  ['溯源结论', '署名不在日志里——它埋在源码中'],
];

interface LogoProps {
  /** md=顶栏 40px；lg=登录页 56px */
  size?: 'md' | 'lg';
  /** 星芒呼吸动画（顶栏启用，与既有视觉一致） */
  pulse?: boolean;
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ size = 'md', pulse = false, className = '' }) => {
  const [signalOpen, setSignalOpen] = useState(false);
  const taps = useRef<number[]>([]);

  /** 徽章连击检测：触发前零暗示，四击即清零；触发后计数复位，可重复观赏。 */
  const registerTap = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < PULSE_TAP_WINDOW_MS), now];
    if (taps.current.length >= PULSE_TAP_COUNT) {
      taps.current = [];
      setSignalOpen(true);
    }
  };

  const badgeClass = size === 'lg' ? 'w-14 h-14 rounded-2xl' : 'w-10 h-10 rounded-xl';
  const iconClass = size === 'lg' ? 'w-7 h-7' : 'w-5 h-5';

  return (
    <>
      <div
        aria-hidden="true"
        className={`${badgeClass} bg-gradient-to-tr from-indigo-600 via-indigo-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-indigo-500/20 ${className}`}
        onClick={registerTap}
      >
        <Sparkles className={`${iconClass} text-white ${pulse ? 'animate-pulse' : ''}`} />
      </div>
      {signalOpen && <PulseSignal onClose={() => setSignalOpen(false)} />}
    </>
  );
};

/** 隐藏信号卡（⌁ PULSE-0 的谜面）：伪装成一条未注册数据源事件；点任意处 / Esc 关闭。 */
const PulseSignal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-md overflow-hidden rounded-2xl border border-indigo-500/30 bg-slate-900 shadow-2xl motion-safe:transition motion-safe:duration-300 ${
          shown ? 'opacity-100' : 'opacity-0 motion-safe:translate-y-2'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-baseline gap-2.5 border-b border-slate-800 px-5 py-3.5">
          <span className="font-mono text-[10px] tracking-[0.2em] text-indigo-400">HIDDEN SOURCE</span>
          <span className="text-xs text-slate-500">检出未注册数据源</span>
        </div>
        <div className="space-y-2.5 px-5 py-4 font-mono text-xs leading-relaxed">
          <div className="flex gap-4">
            <span className="w-16 shrink-0 text-slate-500">代号</span>
            <span className="text-indigo-300">{PULSE_CODE}</span>
          </div>
          {PULSE_ROWS.map(([label, value]) => (
            <div key={label} className="flex gap-4">
              <span className="w-16 shrink-0 text-slate-500">{label}</span>
              <span className="text-slate-200">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
