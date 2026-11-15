/** 智能问数品牌标识（「一笔」）：方砖 + 盘绕笔弧 + 中心一颗点亮核，顶栏与登录页共用。
 *
 * - 符号语义：粗端=涌入的数据，沿绕收细=提炼，中心核=被点亮的判断；
 * - 上色：三层光泽渐变（砖面瓷面 / 笔弧金属 / 核心球面），与小尺寸平面版同色系；
 * - tone：dark=深色 UI 上的透明版（默认，无砖／提亮笔弧／高光核）；light=浅底上的砖版；
 * - size：md=顶栏 56px / lg=登录页 80px；pulse 控制核的呼吸（顶栏启用）；
 * - 与智能运维控制台的「脉冲徽章」同源——同一枚徽章，同一处隐藏信号。
 * - 几何与 .logo-design/kit/symbol.svg 同源（8 段三次贝塞尔拟合），修改请两边同步。
 */
import React, { useEffect, useId, useRef, useState } from 'react';

/** 方砖容器（viewBox 16..240 已裁到砖边）。 */
const TILE_PATH = 'M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16Z';

/** 笔弧：粗端带宽 40，逆时针盘绕 305° 收成尖。 */
const MARK_BAND = [
  'M203.34 148.19',
  'C197.23 163.86 185.91 177.37 171.36 185.8',
  'C157.91 193.57 141.9 196.82 126.55 194.48',
  'C112.47 192.34 99.09 185.46 89.46 174.96',
  'C80.7 165.41 75.11 152.84 74.3 139.9',
  'C73.58 128.26 76.8 116.19 83.59 106.7',
  'C89.63 98.26 98.73 91.68 108.76 88.99',
  'C117.54 86.63 127.51 87.25 135.77 91.06',
  'C142.86 94.33 149.23 100.35 152.51 107.43',
  'C148.05 101.72 141.78 97.69 134.74 95.95',
  'C127.54 94.18 119.94 94.9 113.18 97.95',
  'C106.27 101.08 100.62 106.46 97.12 113.19',
  'C93.54 120.06 92.4 127.96 93.83 135.58',
  'C95.29 143.36 99.36 150.42 105.32 155.64',
  'C111.41 160.96 119.13 164.07 127.2 164.49',
  'C135.45 164.93 143.6 162.55 150.35 157.8',
  'C157.24 152.95 162.28 145.9 164.71 137.84',
  'A20 20 0 0 0 203.34 148.19Z',
].join('');

/** 核（r22）：全标唯一的彩色点。 */
const CORE_PATH = 'M150 128A22 22 0 1 1 106 128A22 22 0 1 1 150 128Z';
/** 品牌主色：小尺寸单色场景（favicon）用 BRAND_INK；大尺寸铺三层渐变产生光泽。 */
const BRAND_INK = '#4F46E5';
const BRAND_INK_HI = '#7A73F5';
const BRAND_INK_LO = '#4033C4';
/** 深色底透明版：砖退场，笔弧提亮到 slate-900 上 7.6:1→3.2:1，核加高光。 */
const ON_DARK_HI = '#ABA6FC';
const ON_DARK = '#7C74F5';
const ON_DARK_LO = '#5B51E8';
const ON_DARK_CORE_HI = '#D9FCFF';
const ON_DARK_CORE_LO = '#22D3EE';

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
  /** md=顶栏 56px；lg=登录页 80px */
  size?: 'md' | 'lg';
  /** dark=深色底透明版（默认，无砖）；light=浅底砖版 */
  tone?: 'dark' | 'light';
  /** 核的呼吸动画（顶栏启用） */
  pulse?: boolean;
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ size = 'md', tone = 'dark', pulse = false, className = '' }) => {
  const [signalOpen, setSignalOpen] = useState(false);
  const taps = useRef<number[]>([]);
  /** 渐变 id 必须页内唯一：顶栏与登录页可能同时挂载。 */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  /** 徽章连击检测：触发前零暗示，四击即清零；触发后计数复位，可重复观赏。 */
  const registerTap = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < PULSE_TAP_WINDOW_MS), now];
    if (taps.current.length >= PULSE_TAP_COUNT) {
      taps.current = [];
      setSignalOpen(true);
    }
  };

  const badgeClass = size === 'lg' ? 'w-20 h-20' : 'w-14 h-14';
  const onDark = tone === 'dark';
  const ink = `url(#ink-${uid})`;
  const tile = `url(#tile-${uid})`;
  const core = `url(#core-${uid})`;

  return (
    <>
      <div
        aria-hidden="true"
        className={`${badgeClass} shrink-0 ${className}`}
        onClick={registerTap}
      >
        {/* 深底不画砖：viewBox 收到笔弧外接框，避免透明后视觉尺寸缩水 */}
        <svg viewBox={onDark ? '44 44 168 168' : '16 16 224 224'} className="w-full h-full block">
          <defs>
            {/* 笔弧金属：左上受光偏亮，绕到底部收紧为暗端 */}
            <linearGradient
              id={`ink-${uid}`}
              gradientUnits="userSpaceOnUse"
              x1={onDark ? 60 : 42}
              y1={onDark ? 52 : 18}
              x2={onDark ? 200 : 214}
              y2={onDark ? 210 : 238}
            >
              <stop offset="0%" stopColor={onDark ? ON_DARK_HI : BRAND_INK_HI} />
              <stop offset="46%" stopColor={onDark ? ON_DARK : BRAND_INK} />
              <stop offset="100%" stopColor={onDark ? ON_DARK_LO : BRAND_INK_LO} />
            </linearGradient>
            {/* 砖面瓷面：仅浅底砖版使用 */}
            <linearGradient id={`tile-${uid}`} gradientUnits="userSpaceOnUse" x1="44" y1="20" x2="198" y2="240">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="58%" stopColor="#FBFBFF" />
              <stop offset="100%" stopColor="#EBEEFC" />
            </linearGradient>
            {/* 核心球面：高光偏左上，边缘回落到青 */}
            <radialGradient id={`core-${uid}`} gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
              <stop offset="0%" stopColor={onDark ? ON_DARK_CORE_HI : '#C7F9FE'} />
              <stop offset="44%" stopColor="#5FE9F6" />
              <stop offset="100%" stopColor={onDark ? ON_DARK_CORE_LO : '#1FC4E4'} />
            </radialGradient>
          </defs>
          {!onDark && <path fill={tile} d={TILE_PATH} />}
          <path fill={onDark ? ink : '#FFFFFF'} d={MARK_BAND} />
          <path fill={core} d={CORE_PATH} className={pulse ? 'animate-pulse' : undefined} />
        </svg>
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
