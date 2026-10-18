/**
 * 男声旁白 TTS 配置（借用 demo-video-agent 0.2.x CLI 生成 audio-male/）。
 *
 * 女声侧 generate-tts.mjs 与 narration.md 保持不变；本配置只写 audio-male/，互不影响。
 *
 * 用法：
 *   DV_ROOT=~/.qoder/plugins/cache/local/demo-video-agent/0.2.2
 *   DV_TTS_PROXY=http://127.0.0.1:7890,http://127.0.0.1:7891 \
 *     node "$DV_ROOT/engine/cli.mjs" tts --config scripts/demo-video/male-tts.config.mjs
 *   # 只重生成某幕：追加 --scenes m00
 */
export default {
  name: '智能问数-男声旁白',
  narration: 'narration-male.md',
  dirs: { audio: 'audio-male' },
  tts: { gender: 'male', rate: '-4%' },
  scenes: [
    { id: 'm00', title: '片头' },
    { id: 'm0', title: '总览' },
    { id: 'm01', title: '架构导览' },
    { id: 'm1', title: '登录' },
    { id: 'm2', title: '问数' },
    { id: 'm3', title: '报表' },
    { id: 'm4', title: '看板' },
    { id: 'm5', title: '灵活查询' },
    { id: 'm6', title: '知识库' },
    { id: 'm7', title: '管理' },
    { id: 'm8', title: '治理' },
    { id: 'm8b', title: '双闭环' },
    { id: 'm8c', title: '记忆体' },
    { id: 'm9', title: '收尾' },
    { id: 'm10', title: '片尾' },
  ],
};
