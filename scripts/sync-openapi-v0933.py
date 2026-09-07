#!/usr/bin/env python3
"""v0.9.33：补齐指标库 / SQL 样例库导入导出 4 个端点（docs:check 对齐）。"""
import json
from collections import OrderedDict

PATH = 'docs/openapi.json'

with open(PATH, encoding='utf-8') as f:
    doc = json.load(f, object_pairs_hook=OrderedDict)

paths = doc['paths']


def op(tag, opid, summary, extra_responses=None, body=None, params=None):
    o = OrderedDict()
    o['tags'] = [tag]
    o['operationId'] = opid
    o['summary'] = summary
    if params:
        o['parameters'] = params
    if body:
        o['requestBody'] = {'required': True, 'content': {'application/json': {'schema': body}}}
    resps = OrderedDict()
    resps['200'] = {'description': '成功'}
    for code in (extra_responses or []):
        resps[str(code)] = {'$ref': f'#/components/responses/{code}'}
    o['responses'] = resps
    return o


def query_param(name, desc=''):
    p = OrderedDict()
    p['name'] = name
    p['in'] = 'query'
    p['required'] = True
    if desc:
        p['description'] = desc
    p['schema'] = {'type': 'string'}
    return p


NEW = {
    '/api/metrics/export': {
        'get': op('Metrics', 'exportMetrics', '指标库导出（仅 ADMIN；JSON 备份，含口径/同义词/维度/治理状态，剥离库内 id 与审批痕迹）',
                  ['Forbidden', 'NotFound'],
                  params=[query_param('dataSourceId', '数据源 ID')]),
    },
    '/api/metrics/import': {
        'post': op('Metrics', 'importMetrics', '指标库导入（仅 ADMIN；同名冲突 skip/overwrite，overwrite 版本 +1 留历史；支持 dryRun 预检）',
                   ['BadRequest', 'Forbidden', 'NotFound'],
                   body={'type': 'object', 'required': ['fileData'],
                         'properties': {'fileData': {'type': 'object'},
                                        'dataSourceId': {'type': 'string'},
                                        'mergeStrategy': {'type': 'string', 'enum': ['skip', 'overwrite']},
                                        'dryRun': {'type': 'boolean'}}}),
    },
    '/api/sql-examples/export': {
        'get': op('SqlExamples', 'exportSqlExamples', 'SQL 样例库导出（仅 ADMIN；JSON 备份，含问题/SQL/来源标记）',
                  ['Forbidden', 'NotFound'],
                  params=[query_param('dataSourceId', '数据源 ID')]),
    },
    '/api/sql-examples/import': {
        'post': op('SqlExamples', 'importSqlExamples', 'SQL 样例库导入（仅 ADMIN；同问题冲突 skip/overwrite/append，新增记 IMPORT 来源；支持 dryRun 预检）',
                   ['BadRequest', 'Forbidden', 'NotFound'],
                   body={'type': 'object', 'required': ['fileData'],
                         'properties': {'fileData': {'type': 'object'},
                                        'dataSourceId': {'type': 'string'},
                                        'mergeStrategy': {'type': 'string', 'enum': ['skip', 'overwrite', 'append']},
                                        'dryRun': {'type': 'boolean'}}}),
    },
}

# 插入位置：metrics 两个端点跟在 /api/metrics/query 之后；sql-examples 两个端点跟在 /api/sql-examples/bulk 之后
AFTER = {
    '/api/metrics/query': ['/api/metrics/export', '/api/metrics/import'],
    '/api/sql-examples/bulk': ['/api/sql-examples/export', '/api/sql-examples/import'],
}

rebuilt = OrderedDict()
for p, item in paths.items():
    rebuilt[p] = item
    for new_path in AFTER.get(p, []):
        if new_path not in paths:
            rebuilt[new_path] = NEW.pop(new_path)

# 兜底：锚点未命中时追加到末尾
for new_path, item in NEW.items():
    if new_path not in rebuilt:
        rebuilt[new_path] = item

doc['paths'] = rebuilt

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('added: /api/metrics/export, /api/metrics/import, /api/sql-examples/export, /api/sql-examples/import')
