/**
 * 数据源 Schema 规范类型（P0-2 类型纪律收敛）：
 * schema_json 的单一事实源——提取组装（routes/datasources.assembleTables 的 AssembledTable 同形）、
 * 上下文缓存（schemaContext）、圈表/列裁剪（schemaLinking）、prompt 序列化（schemaGuidance）、
 * 权限/敏感过滤（scope、queryGuard）共用同一类型，替代全链路 any[]。
 * 索引签名保留宽松扩展位：前端演示模式提交的 schema 与历史落库数据可能携带额外字段。
 */
export interface SchemaColumn {
  name: string;
  type?: string;
  description?: string;
  isPrimaryKey?: boolean;
  isDimension?: boolean;
  isMetric?: boolean;
  [key: string]: unknown;
}

export interface SchemaTable {
  name: string;
  id?: string;
  displayName?: string;
  description?: string;
  /** 管理员登记的表级业务口径（注入 prompt 约束 SQL 生成） */
  businessNote?: string;
  rowCount?: number;
  tableType?: string;
  columns?: SchemaColumn[];
  [key: string]: unknown;
}
