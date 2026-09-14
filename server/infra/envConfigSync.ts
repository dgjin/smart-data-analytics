/**
 * v0.9.61 环境配置在线化：启动合并（env_config 表 → process.env，IO 薄包装）。
 *
 * 面板（PUT /api/admin/env-config）保存后即时热更写 process.env；本模块保证重启后
 * 面板值依然优先（从表回读合并）。fail-open：读表失败仅告警不阻断启动
 * （未授权/异常场景保持 .env.local 语义）。
 */
import { getPool } from './db';
import { logger } from './logger';
import { applyEnvConfigToProcess, mergeableRows } from './envConfigCatalog';

/** 读取 env_config 并把非空保存值合并进 process.env；返回实际生效（值发生变化）的 key 数 */
export async function loadEnvConfigIntoProcess(): Promise<number> {
  try {
    const [rows] = await getPool().query('SELECT `key`, `value` FROM env_config');
    const applied = applyEnvConfigToProcess(mergeableRows(rows as Array<{ key: string; value: string | null }>));
    if (applied.length > 0) {
      logger.info(`[EnvConfig] 面板配置已合并到运行时 ${applied.length} 项：${applied.join(', ')}`);
    }
    return applied.length;
  } catch (err: any) {
    logger.warn('[EnvConfig] 面板配置合并失败（忽略，继续以 .env.local 运行）:', err?.message || err);
    return 0;
  }
}
