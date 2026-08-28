/**
 * P3-1 业务知识库服务 - 支持完整生命周期的 CRUD 操作
 * 功能：知识条目的增删改查、导入导出、版本控制
 */

import { getPool } from './db';
import { Pool } from 'mysql2/promise';
import { KnowledgeBaseItem } from '../src/types/analytics';

/**
 * 将数据库行对象转换为前端使用的 KnowledgeBaseItem 格式
 */
export function rowToKnowledgeItem(row: any): KnowledgeBaseItem {
  return {
    id: row.entry_id,
    title: row.title,
    content: row.content,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 根据数据源 ID 获取所有预置知识条目（用于智能问数上下文注入）
 * @param dataSourceId 数据源 ID（如 ds_data_resource_001）
 * @returns 知识条目列表
 */
export async function getPresetKnowledgeByDataSource(
  dataSourceId: string
): Promise<KnowledgeBaseItem[]> {
  const conn = await getPool().getConnection();
  try {
    const [rows] = await conn.query<KnowledgeBaseItem[]>(
      `SELECT entry_id AS id, title, content, tags, category, created_at AS createdAt, updated_at AS updatedAt 
       FROM knowledge_base_entries 
       WHERE data_source_id = ? AND is_preset = 1 
       ORDER BY created_at ASC`,
      [dataSourceId]
    );
    
    // 兼容历史查询：返回数组而非单个对象
    if (Array.isArray(rows)) {
      return rows.map(rowToKnowledgeItem);
    }
    return [];
  } finally {
    conn.release();
  }
}

/**
 * 获取所有数据源的知识条目（管理员专用）
 * @returns 知识条目列表（按数据源分组）
 */
export async function getAllKnowledgeEntries(): Promise<KnowledgeBaseItem[]> {
  const [rows] = await getPool().query(
    `SELECT entry_id AS id, title, content, tags, category, data_source_id, created_by, updated_by, 
            created_at AS createdAt, updated_at AS updatedAt 
     FROM knowledge_base_entries 
     ORDER BY data_source_id, title ASC`
  );
  
  return Array.isArray(rows) ? rows.map(rowToKnowledgeItem) : [];
}

/**
 * 按 ID 查找单个知识条目
 * @param entryId 唯一标识符（如 kb_001）
 * @returns 知识条目或 null
 */
export async function getKnowledgeEntryById(entryId: string): Promise<KnowledgeBaseItem | null> {
  const [rows] = await getPool().query(
    `SELECT entry_id AS id, title, content, tags, category, data_source_id, created_by, updated_by, 
            created_at AS createdAt, updated_at AS updatedAt 
     FROM knowledge_base_entries 
     WHERE entry_id = ?`,
    [entryId]
  );
  
  if (Array.isArray(rows) && rows.length > 0) {
    return rowToKnowledgeItem(rows[0]);
  }
  return null;
}

/**
 * 插入新的知识条目（预置数据初始化用）
 * @param entry 知识条目数据
 * @returns 插入 ID
 */
export async function createKnowledgeEntry(entry: {
  entryId: string;
  dataSourceId: string;
  title: string;
  content: string;
  tags: string[];
  category: string;
  createdBy?: string;
  isPreset?: boolean;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO knowledge_base_entries (
      entry_id, data_source_id, title, content, tags, category, is_preset, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.entryId,
      entry.dataSourceId,
      entry.title,
      entry.content,
      JSON.stringify(entry.tags),
      entry.category,
      entry.isPreset ? 1 : 0,
      entry.createdBy || 'system-seed',
    ]
  );
}

/**
 * 更新知识条目（仅非预置条目可编辑）
 * @param entryId 唯一标识符
 * @param updates 更新字段
 * @param updatedBy 更新者用户名
 */
export async function updateKnowledgeEntry(
  entryId: string,
  updates: {
    title?: string;
    content?: string;
    tags?: string[];
    category?: string;
  },
  updatedBy: string
): Promise<boolean> {
  // 检查是否为预置条目（禁止修改）
  const [presets] = await getPool().query<{ is_preset: number }[]>(
    'SELECT is_preset FROM knowledge_base_entries WHERE entry_id = ?',
    [entryId]
  );
  
  if (Array.isArray(presets) && presets.length > 0 && presets[0].is_preset === 1) {
    throw new Error(`无法修改预置知识条目：${entryId}`);
  }
  
  // 构建 SET 子句
  const setFields: string[] = [];
  const values: any[] = [];
  
  if (updates.title !== undefined) {
    setFields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.content !== undefined) {
    setFields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.tags !== undefined) {
    setFields.push('tags = ?');
    values.push(JSON.stringify(updates.tags));
  }
  if (updates.category !== undefined) {
    setFields.push('category = ?');
    values.push(updates.category);
  }
  
  if (setFields.length === 0) return false;
  
  // 追加 updated_by 和 updated_at
  setFields.push('updated_by = ?');
  values.push(updatedBy);
  
  const sql = `UPDATE knowledge_base_entries SET ${setFields.join(', ')} WHERE entry_id = ?`;
  values.push(entryId);
  
  const [result] = await getPool().query(sql, values);
  return result.affectedRows > 0;
}

/**
 * 删除知识条目
 * @param entryId 唯一标识符
 */
export async function deleteKnowledgeEntry(entryId: string): Promise<boolean> {
  const [presets] = await getPool().query<{ is_preset: number }[]>(
    'SELECT is_preset FROM knowledge_base_entries WHERE entry_id = ?',
    [entryId]
  );
  
  if (Array.isArray(presets) && presets.length > 0 && presets[0].is_preset === 1) {
    throw new Error(`无法删除预置知识条目：${entryId}`);
  }
  
  const [result] = await getPool().query(
    'DELETE FROM knowledge_base_entries WHERE entry_id = ?',
    [entryId]
  );
  
  return result.affectedRows > 0;
}

/**
 * 批量初始化种子数据（应用启动时调用）
 * @param dataSourceId 数据源 ID
 * @param entries 知识条目数组
 * @param createdBy 创建者
 */
export async function seedKnowledgeBase(
  dataSourceId: string,
  entries: Array<{ id: string; title: string; content: string; tags: string[]; category: string }>,
  createdBy: string = 'system-seed'
): Promise<void> {
  const conn = await getPool().getConnection();
  
  try {
    await conn.beginTransaction();
    
    for (const entry of entries) {
      try {
        await conn.query(
          `INSERT INTO knowledge_base_entries (
            entry_id, data_source_id, title, content, tags, category, is_preset, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          ON DUPLICATE KEY UPDATE 
            title = VALUES(title),
            content = VALUES(content),
            tags = VALUES(tags),
            category = VALUES(category)`,
          [
            entry.id,
            dataSourceId,
            entry.title,
            entry.content,
            JSON.stringify(entry.tags),
            entry.category,
            createdBy,
          ]
        );
      } catch (err: any) {
        console.error(`[KB Seed] Failed to insert ${entry.id}:`, err.message);
        // 继续处理下一个条目
      }
    }
    
    await conn.commit();
    console.log(`[KB Seed] Successfully seeded ${entries.length} entries for ${dataSourceId}`);
  } catch (err: any) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
