#!/usr/bin/env python3
"""v0.9.48：补齐 P0-1 异常巡检 6 端点 / P0-2 报告 Excel·Word 导出 2 端点（docs:check 对齐）。"""
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


def path_param(name, desc=''):
    p = OrderedDict()
    p['name'] = name
    p['in'] = 'path'
    p['required'] = True
    if desc:
        p['description'] = desc
    p['schema'] = {'type': 'string'}
    return p


def query_param(name, desc='', required=False):
    p = OrderedDict()
    p['name'] = name
    p['in'] = 'query'
    p['required'] = required
    if desc:
        p['description'] = desc
    p['schema'] = {'type': 'string'}
    return p


REPORT_EXPORT_BODY = {
    'type': 'object',
    'required': ['report'],
    'properties': {'report': {'type': 'object'}, 'charts': {'type': 'array', 'items': {'type': 'string'}}},
}

NEW = OrderedDict({
    '/api/report/export-excel': {
        'post': op('Reports', 'exportReportExcel',
                   '报告 Excel 导出（服务端 exceljs 组装多工作表；body 上限 20MB 含图表 base64）',
                   ['BadRequest', 'Forbidden', 'RateLimited'],
                   body=REPORT_EXPORT_BODY),
    },
    '/api/report/export-word': {
        'post': op('Reports', 'exportReportWord',
                   '报告 Word 导出（服务端 docx 组装图文混排；body 上限 20MB 含图表 base64）',
                   ['BadRequest', 'Forbidden', 'RateLimited'],
                   body=REPORT_EXPORT_BODY),
    },
    '/api/patrols': {
        'get': op('Patrols', 'listPatrols', '巡检计划列表（可按数据源过滤）',
                  params=[query_param('dataSourceId', '数据源 ID（可选）')]),
        'post': op('Patrols', 'createPatrol', '新建巡检计划（仅 ADMIN/ANALYST；绑定数据源 + 巡检间隔分钟）',
                   ['BadRequest', 'Forbidden', 'NotFound'],
                   body={'type': 'object', 'required': ['dataSourceId', 'intervalMinutes'],
                         'properties': {'dataSourceId': {'type': 'string'},
                                        'intervalMinutes': {'type': 'integer'},
                                        'name': {'type': 'string'}}}),
    },
    '/api/patrols/{patrolId}': {
        'put': op('Patrols', 'updatePatrol', '更新巡检计划（名称/间隔/启停；仅创建人或 ADMIN）',
                  ['BadRequest', 'Forbidden', 'NotFound'],
                  body={'type': 'object',
                        'properties': {'name': {'type': 'string'},
                                       'intervalMinutes': {'type': 'integer'},
                                       'status': {'type': 'string', 'enum': ['ACTIVE', 'PAUSED']}}},
                  params=[path_param('patrolId', '巡检计划 ID')]),
        'delete': op('Patrols', 'deletePatrol', '删除巡检计划及其运行历史（仅创建人或 ADMIN）',
                     ['Forbidden', 'NotFound'],
                     params=[path_param('patrolId', '巡检计划 ID')]),
    },
    '/api/patrols/{patrolId}/run': {
        'post': op('Patrols', 'runPatrol', '立即执行一次巡检（仅创建人或 ADMIN；不改变既有排期）',
                   ['Forbidden', 'NotFound', 'RateLimited'],
                   params=[path_param('patrolId', '巡检计划 ID')]),
    },
    '/api/patrols/{patrolId}/runs': {
        'get': op('Patrols', 'listPatrolRuns', '巡检运行历史（新→旧，含异常明细；limit 默认 20）',
                  ['NotFound'],
                  params=[path_param('patrolId', '巡检计划 ID'), query_param('limit', '返回条数（默认 20）')]),
    },
})

# 插入位置：报告导出跟在 /api/report/export-pdf 之后；巡检端点跟在 saved-reports 批注端点之后
AFTER = OrderedDict({
    '/api/report/export-pdf': ['/api/report/export-excel', '/api/report/export-word'],
    '/api/saved-reports/{reportId}/comments': ['/api/patrols', '/api/patrols/{patrolId}',
                                               '/api/patrols/{patrolId}/run', '/api/patrols/{patrolId}/runs'],
})

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

# 新增 Patrols tag（不存在时追加）
if 'tags' in doc and not any(t.get('name') == 'Patrols' for t in doc['tags']):
    doc['tags'].append(OrderedDict([
        ('name', 'Patrols'),
        ('description', 'P0-1 异常巡检订阅（数据源级巡检计划与运行历史）'),
    ]))

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('added: /api/report/export-excel, /api/report/export-word, /api/patrols (6 端点)')
