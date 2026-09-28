/**
 * DOM 快照转 PNG 工具（v0.9.82）：报告导出与问数结果导出共用的截图函数。
 *
 * 背景：报告链路（ExecutiveReportCard）与问数结果导出（ChatMessageItem）都需要把深色底图表块
 * 原样截图交给服务端嵌入 PDF/Word/PPT——foreignObject 方案（DOM 克隆 + 递归内联计算样式 →
 * SVG → canvas 2x 光栅化）能保留页面配色/字体/HTML 图例，比纯 SVG 序列化更完整。
 * 两个调用方逻辑完全一致，抽取到本模块避免实现分叉。
 *
 * 浏览器安全限制（Safari 对 foreignObject 光栅化会 taint canvas）导致失败时返回 null，
 * 由调用方自行决定回退策略（如改用 svgToPng 序列化）。
 */

/** 取元素向上最近的非透明背景色（通常为卡片深底 #0f172a），避免透明底落到白色纸面上浅色文字不可读 */
export function findCaptureBackground(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = window.getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    node = node.parentElement;
  }
  return '#0f172a';
}

/** 递归内联计算样式：快照脱离文档后仍保持页面字体/颜色/布局（recharts 图例是 HTML，必须随样式一起走） */
function inlineComputedStyles(src: Element, dst: Element) {
  const cs = window.getComputedStyle(src);
  let cssText = '';
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i];
    cssText += `${prop}:${cs.getPropertyValue(prop)};`;
  }
  dst.setAttribute('style', cssText);
  const srcKids = src.children;
  const dstKids = dst.children;
  for (let i = 0; i < srcKids.length; i++) {
    inlineComputedStyles(srcKids[i], dstKids[i]);
  }
}

/** DOM 原样快照 → PNG base64（foreignObject 方案：图表主体 + HTML 图例作为一个整体导出，
 * 保留页面配色/字体/深底；浏览器安全限制导致光栅化失败时返回 null，由调用方回退 SVG 序列化） */
export function captureElementPng(el: HTMLElement, bgColor: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const rect = el.getBoundingClientRect();
      const w = Math.max(Math.round(rect.width), 400);
      const h = Math.max(Math.round(rect.height), 200);
      const cloned = el.cloneNode(true) as HTMLElement;
      inlineComputedStyles(el, cloned);
      // 悬停 tooltip 属交互瞬态，不应出现在导出图上
      cloned.querySelectorAll('.recharts-tooltip-wrapper').forEach((n) => n.remove());
      cloned.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      cloned.style.width = `${rect.width}px`;
      cloned.style.height = `${rect.height}px`;
      cloned.style.backgroundColor = bgColor;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        `<foreignObject x="0" y="0" width="100%" height="100%">` +
        new XMLSerializer().serializeToString(cloned) +
        `</foreignObject></svg>`;
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w * 2;
          canvas.height = h * 2;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null); // Safari 对 foreignObject 光栅化会 taint canvas
        }
      };
      img.onerror = () => resolve(null);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      resolve(null);
    }
  });
}
