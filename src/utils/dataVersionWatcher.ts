/**
 * v0.4.8 数据版本变化检测状态机（纯逻辑，便于单测）：
 * 首次 feed 仅建立基线不触发回调；后续 feed 到不同版本才判定为「数据变化」。
 * 探测失败（version=null）不更新基线也不触发，静默跳过本轮。
 */
export class DataVersionWatcher {
  private baseline: string | null = null;

  /** 当前基线版本（未建立为 null） */
  get current(): string | null {
    return this.baseline;
  }

  /**
   * 喂入一次探测结果。返回 true 表示检测到数据变化（基线已建立且版本不同），
   * 同时把基线推进到新版本；false 表示首轮建基线 / 无变化 / 探测失败。
   */
  feed(version: string | null): boolean {
    if (!version) return false;
    if (this.baseline === null) {
      this.baseline = version;
      return false;
    }
    if (version === this.baseline) return false;
    this.baseline = version;
    return true;
  }

  /** 重置基线（数据源切换/手动刷新后重新建立） */
  reset(): void {
    this.baseline = null;
  }
}
