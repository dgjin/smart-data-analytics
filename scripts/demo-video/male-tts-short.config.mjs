/**
 * 精华版（4–5 分钟）男声旁白 TTS 配置（仅供记录，当前不可用）。
 *
 * 注：demo-video-agent 0.5.0 的 `tts --config` 会校验每幕必须带画面源
 * （overlay / run() / asset / terminal），本片各幕画面由独立脚本驱动，
 * 因此实际改用 generate-tts-short-male.mjs 直接调 edge-tts 生成 audio-short-male/。
 *
 * narration-short-male.md 与女声稿逐句同文，保证 make-male-version-short.mjs 的句级校验通过。
 *
 * 用法：
 *   VTT=1 node scripts/demo-video/generate-tts-short-male.mjs
 *   # 只重生成某幕：SCENES=s00 node scripts/demo-video/generate-tts-short-male.mjs
 */
export default {
  name: '智能问数-精华版-男声旁白',
  narration: 'narration-short-male.md',
  dirs: { audio: 'audio-short-male' },
  tts: { gender: 'male', rate: '-4%' },
  scenes: [
    { id: 's00', title: '片头' },
    { id: 's01', title: '总览与治理闭环' },
    { id: 's02', title: '智能问数核心链路' },
    { id: 's03', title: '决策报表' },
    { id: 's04', title: '决策看板' },
    { id: 's05', title: '灵活查询' },
    { id: 's06', title: '数据源与血缘' },
    { id: 's07', title: '双闭环与记忆体' },
    { id: 's08', title: '收尾与片尾' },
  ],
};
