#!/usr/bin/env python3
"""一次性补齐 docs/openapi.json 缺失的 39 个端点（docs:check 对齐）。"""
import json
from collections import OrderedDict

PATH = 'docs/openapi.json'

with open(PATH, encoding='utf-8') as f:
    doc = json.load(f, object_pairs_hook=OrderedDict)

paths = doc['paths']

def param(name, desc=''):
    p = OrderedDict()
    p['name'] = name
    p['in'] = 'path'
    p['required'] = True
    if desc:
        p['description'] = desc
    p['schema'] = {'type': 'string'}
    return p

def op(tag, opid, summary, extra_responses=None, body=None):
    o = OrderedDict()
    o['tags'] = [tag]
    o['operationId'] = opid
    o['summary'] = summary
    if body:
        o['requestBody'] = {'required': True, 'content': {'application/json': {'schema': body}}}
    resps = OrderedDict()
    resps['200'] = {'description': '成功'}
    for code in (extra_responses or []):
        resps[str(code)] = {'$ref': f'#/components/responses/{code}'}
    o['responses'] = resps
    return o

def add(path, method, operation, params=None):
    if path not in paths:
        paths[path] = OrderedDict()
    if params:
        paths[path]['parameters'] = params
    paths[path][method] = operation

# ---- Auth: OIDC ----
add('/api/auth/oidc/login', 'get', op('Auth', 'oidcLogin', 'OIDC 登录跳转（重定向到企业 IdP 授权页）'))
add('/api/auth/oidc/callback', 'get', op('Auth', 'oidcCallback', 'OIDC 授权回调（换取 token 并建立会话）'))
add('/api/auth/oidc/status', 'get', op('Auth', 'oidcStatus', 'OIDC 配置状态（是否启用，供登录页展示入口）'))

# ---- DataSources ----
add('/api/datasources/{id}/data-version', 'get',
    op('DataSources', 'getDataVersion', '数据版本指纹（看板/报表轮询检测底层数据变化；服务端 10s 缓存）', ['NotFound']),
    [param('id', '数据源 ID')])
add('/api/datasources/{id}/flex-schema', 'get',
    op('DataSources', 'getFlexSchema', '灵活查询只读 Schema（ADMIN/ANALYST；受数据源 ACL 约束）', ['Forbidden', 'NotFound']),
    [param('id', '数据源 ID')])
add('/api/datasources/{id}/acl', 'put',
    op('DataSources', 'updateDataSourceAcl', '数据源访问控制清单（仅 ADMIN；空 = 全员可见）', ['BadRequest', 'Forbidden', 'NotFound'],
       body={'type': 'object', 'properties': {'departments': {'type': 'array', 'items': {'type': 'string'}}, 'userIds': {'type': 'array', 'items': {'type': 'integer'}}}}),
    [param('id', '数据源 ID')])

# ---- AccessRequests ----
add('/api/access-requests', 'post',
    op('AccessRequests', 'createAccessRequest', '提交数据源访问申请', ['BadRequest'],
       body={'type': 'object', 'required': ['dataSourceId'], 'properties': {'dataSourceId': {'type': 'string'}, 'reason': {'type': 'string'}}}))
add('/api/access-requests/mine', 'get', op('AccessRequests', 'listMyAccessRequests', '我的访问申请列表'))
add('/api/access-requests', 'get', op('AccessRequests', 'listAccessRequests', '全部访问申请（仅 ADMIN）', ['Forbidden']))
add('/api/access-requests/{id}/approve', 'post',
    op('AccessRequests', 'approveAccessRequest', '审批通过（仅 ADMIN）', ['Forbidden', 'NotFound']),
    [param('id', '申请 ID')])
add('/api/access-requests/{id}/reject', 'post',
    op('AccessRequests', 'rejectAccessRequest', '审批驳回（仅 ADMIN）', ['Forbidden', 'NotFound'],
       body={'type': 'object', 'properties': {'comment': {'type': 'string'}}}),
    [param('id', '申请 ID')])

# ---- Export（DLP 统一导出通道） ----
add('/api/export/csv', 'post',
    op('Export', 'exportCsv', 'CSV 统一导出通道（DLP 脱敏 + 水印；超阈值转下载审批）', ['BadRequest', 'RateLimited'],
       body={'type': 'object', 'required': ['dataSourceId', 'sql'], 'properties': {'dataSourceId': {'type': 'string'}, 'sql': {'type': 'string'}, 'filename': {'type': 'string'}}}))
add('/api/export/requests/mine', 'get', op('Export', 'listMyExportRequests', '我的导出审批申请'))
add('/api/export/requests', 'get', op('Export', 'listExportRequests', '全部导出审批申请（仅 ADMIN）', ['Forbidden']))
add('/api/export/requests/{id}/approve', 'post',
    op('Export', 'approveExportRequest', '导出审批通过（仅 ADMIN）', ['Forbidden', 'NotFound']),
    [param('id', '审批单 ID')])
add('/api/export/requests/{id}/reject', 'post',
    op('Export', 'rejectExportRequest', '导出审批驳回（仅 ADMIN）', ['Forbidden', 'NotFound'],
       body={'type': 'object', 'properties': {'comment': {'type': 'string'}}}),
    [param('id', '审批单 ID')])

# ---- ExternalKnowledge（仅 ADMIN） ----
add('/api/knowledge-external', 'get', op('ExternalKnowledge', 'listExternalKb', '外部知识库配置列表（仅 ADMIN；api_key 不出明文）', ['Forbidden']))
add('/api/knowledge-external', 'post',
    op('ExternalKnowledge', 'createExternalKb', '新增外部知识库配置（仅 ADMIN）', ['BadRequest', 'Forbidden'],
       body={'type': 'object', 'required': ['name', 'endpoint'], 'properties': {'name': {'type': 'string'}, 'endpoint': {'type': 'string'}, 'apiKey': {'type': 'string'}, 'enabled': {'type': 'boolean'}}}))
add('/api/knowledge-external/{id}', 'put',
    op('ExternalKnowledge', 'updateExternalKb', '更新外部知识库配置（仅 ADMIN）', ['BadRequest', 'Forbidden', 'NotFound']),
    [param('id', '配置 ID')])
add('/api/knowledge-external/{id}', 'delete',
    op('ExternalKnowledge', 'deleteExternalKb', '删除外部知识库配置（仅 ADMIN）', ['Forbidden', 'NotFound']),
    [param('id', '配置 ID')])
add('/api/knowledge-external/test', 'post',
    op('ExternalKnowledge', 'testExternalKb', '测试外部知识库连通性（仅 ADMIN）', ['BadRequest', 'Forbidden'],
       body={'type': 'object', 'properties': {'endpoint': {'type': 'string'}, 'apiKey': {'type': 'string'}}}))

# ---- Knowledge ----
add('/api/knowledge/export', 'get', op('Knowledge', 'exportKnowledge', '知识库导出（JSON 备份，含元数据与版本信息）', ['Forbidden']))
add('/api/knowledge/seed-entries', 'get', op('Knowledge', 'listSeedEntries', '预置知识条目列表（内置种子数据）'))
add('/api/knowledge/import', 'post',
    op('Knowledge', 'importKnowledge', '知识库导入（合并策略 replace/append/skip；body 上限 10mb）', ['BadRequest', 'Forbidden'],
       body={'type': 'object', 'required': ['data'], 'properties': {'data': {'type': 'object'}, 'mergeStrategy': {'type': 'string', 'enum': ['replace', 'append', 'skip']}, 'dryRun': {'type': 'boolean'}}}))

# ---- Metrics ----
add('/api/metrics/query', 'post',
    op('Metrics', 'queryMetric', '指标查询试算（ADMIN/ANALYST）', ['BadRequest', 'Forbidden'],
       body={'type': 'object', 'required': ['metricId'], 'properties': {'metricId': {'type': 'integer'}, 'dimensions': {'type': 'array', 'items': {'type': 'string'}}}}))
add('/api/metrics/{id}/versions', 'get',
    op('Metrics', 'listMetricVersions', '指标版本历史', ['NotFound']),
    [param('id', '指标 ID')])
add('/api/metrics/{id}/approve', 'post',
    op('Metrics', 'approveMetric', '指标审批通过（仅 ADMIN）', ['Forbidden', 'NotFound']),
    [param('id', '指标 ID')])
add('/api/metrics/{id}/reject', 'post',
    op('Metrics', 'rejectMetric', '指标审批驳回（仅 ADMIN）', ['Forbidden', 'NotFound'],
       body={'type': 'object', 'properties': {'comment': {'type': 'string'}}}),
    [param('id', '指标 ID')])
add('/api/metrics/{id}/repropose', 'post',
    op('Metrics', 'reproposeMetric', '指标重新提请审批', ['NotFound']),
    [param('id', '指标 ID')])
add('/api/metrics/{id}/restore', 'post',
    op('Metrics', 'restoreMetricVersion', '指标恢复历史版本（仅 ADMIN）', ['BadRequest', 'Forbidden', 'NotFound'],
       body={'type': 'object', 'required': ['version'], 'properties': {'version': {'type': 'integer'}}}),
    [param('id', '指标 ID')])

# ---- Reports ----
add('/api/report/export-pdf', 'post',
    op('Reports', 'exportReportPdf', '报告 PDF 导出（ReportLab 服务端生成；环境缺 Python 资产时 503 优雅降级）', ['BadRequest'],
       body={'type': 'object', 'required': ['report'], 'properties': {'report': {'type': 'object'}, 'charts': {'type': 'array', 'items': {'type': 'string'}}}}))
add('/api/report/generate-from-query', 'post',
    op('Reports', 'generateReportFromQuery', '从问数结果一键生成报告', ['BadRequest'],
       body={'type': 'object', 'required': ['dataSourceId', 'question'], 'properties': {'dataSourceId': {'type': 'string'}, 'question': {'type': 'string'}, 'templateId': {'type': 'integer'}}}))

# ---- QueryReports ----
add('/api/query-reports', 'get', op('Reports', 'listQueryReports', '问数报告列表（当前用户）'))
add('/api/query-reports/{reportId}', 'get',
    op('Reports', 'getQueryReport', '问数报告详情', ['NotFound']),
    [param('reportId', '报告 ID')])
add('/api/query-reports/{reportId}', 'delete',
    op('Reports', 'deleteQueryReport', '删除问数报告（仅本人或 ADMIN）', ['Forbidden', 'NotFound']),
    [param('reportId', '报告 ID')])

# ---- ReportTemplates ----
add('/api/report-templates', 'get', op('Reports', 'listReportTemplates', '报告模板列表（含预置模板）'))
add('/api/report-templates', 'post',
    op('Reports', 'createReportTemplate', '新建报告模板（仅 ADMIN）', ['BadRequest', 'Forbidden'],
       body={'type': 'object', 'required': ['name', 'templateContent'], 'properties': {'name': {'type': 'string'}, 'description': {'type': 'string'}, 'templateContent': {'type': 'string'}}}))
add('/api/report-templates/{id}', 'put',
    op('Reports', 'updateReportTemplate', '更新报告模板（仅 ADMIN；预置模板不可改）', ['BadRequest', 'Forbidden', 'NotFound']),
    [param('id', '模板 ID')])
add('/api/report-templates/{id}', 'delete',
    op('Reports', 'deleteReportTemplate', '删除报告模板（仅 ADMIN；预置模板不可删）', ['Forbidden', 'NotFound']),
    [param('id', '模板 ID')])

# ---- Tasks（v0.9.2 长任务队列，改进计划 2-1） ----
add('/api/report/generate/async', 'post',
    op('Reports', 'generateReportAsync', '高管报告生成（异步）：提交即返回 taskId，worker 后台执行，前端轮询 /api/tasks/{id}', ['BadRequest', 'RateLimited'],
       body={'type': 'object', 'properties': {'templateType': {'type': 'string'}, 'customPrompt': {'type': 'string'}, 'dataSourceId': {'type': 'string'}, 'reportPlanId': {'type': 'string'}}}))
add('/api/report/generate-from-query/async', 'post',
    op('Reports', 'generateReportFromQueryAsync', '从问数结果生成报告（异步）：提交即返回 taskId，完成后报告写入报告中心', ['BadRequest', 'RateLimited'],
       body={'type': 'object', 'required': ['dataSourceId', 'question'], 'properties': {'dataSourceId': {'type': 'string'}, 'question': {'type': 'string'}, 'templateId': {'type': 'integer'}}}))
add('/api/report/export-pdf/async', 'post',
    op('Export', 'exportReportPdfAsync', '报告 PDF 导出（异步）：提交即返回 taskId，完成后经 /api/tasks/{id}/download 下载', ['BadRequest', 'RateLimited'],
       body={'type': 'object', 'required': ['title'], 'properties': {'title': {'type': 'string'}, 'orientation': {'type': 'string', 'enum': ['portrait', 'landscape']}}}))
add('/api/tasks/mine', 'get', op('Tasks', 'listMyTasks', '我的异步任务列表（状态/进度/结果摘要，按创建时间倒序）'))
add('/api/tasks/{id}', 'get',
    op('Tasks', 'getTask', '异步任务状态查询（JSON 类任务 SUCCESS 时内联返回 result；仅本人或 ADMIN）', ['Forbidden', 'NotFound']),
    [param('id', '任务 ID')])
add('/api/tasks/{id}/download', 'get',
    op('Tasks', 'downloadTaskResult', '文件类任务（PDF）结果下载（仅本人或 ADMIN；任务未完成 409）', ['BadRequest', 'Forbidden', 'NotFound']),
    [param('id', '任务 ID')])

# 补充新 tag 定义
existing_tags = {t['name'] for t in doc.get('tags', [])}
new_tags = {
    'AccessRequests': '数据源访问申请审批流',
    'Export': '统一导出通道（DLP 脱敏/水印/审批）',
    'ExternalKnowledge': '外部知识库接入管理（仅 ADMIN）',
    'Tasks': 'v0.9.2 异步长任务队列（报告生成/导出）',
}
for name, desc in new_tags.items():
    if name not in existing_tags:
        doc['tags'].append(OrderedDict([('name', name), ('description', desc)]))

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('paths now:', len(paths))
