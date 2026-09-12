#!/usr/bin/env python3
"""v0.9.49：补齐 P1-5/6/7/9 高级分析 5 端点（analytics×3 + agent×2，docs:check 对齐）。"""
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


FORECAST_BODY = {
    'type': 'object',
    'required': ['yValues'],
    'properties': {
        'yValues': {'type': 'array', 'items': {'type': 'number'}, 'description': '历史数值序列（3~240 期，按期序）'},
        'xValues': {'type': 'array', 'items': {'type': 'string'}, 'description': '期次标签（可选，需与 yValues 等长）'},
        'periods': {'type': 'integer', 'description': '预测期数 1~24（默认 3）'},
        'model': {'type': 'string', 'enum': ['auto', 'ma', 'lr', 'seasonal'], 'description': 'auto 尾部回测按 MAPE 择优'},
        'seasonalPeriod': {'type': 'integer', 'description': '季节周期（seasonal 模型）'},
        'metricLabel': {'type': 'string', 'description': '指标名（用于解读与审计）'},
        'interpret': {'type': 'boolean', 'description': '是否生成 LLM 解读（默认 true，失败降级 null）'},
    },
}

ATTRIBUTION_BODY = {
    'type': 'object',
    'required': ['rows'],
    'properties': {
        'rows': {'type': 'array', 'items': {'type': 'object'},
                 'description': '模式一：{dims:[...],current,previous} 归因行；模式二：原始数据行 + aggregate 列映射'},
        'aggregate': {'type': 'object',
                      'description': '模式二列映射：服务端按最新两期聚合',
                      'properties': {'dimKey': {'type': 'string'}, 'periodKey': {'type': 'string'},
                                     'metricKey': {'type': 'string'}}},
        'subject': {'type': 'string', 'description': '指标名（用于解读）'},
        'interpret': {'type': 'boolean', 'description': '是否生成 LLM 结论（默认 true）'},
    },
}

WHATIF_BODY = {
    'type': 'object',
    'required': ['dataSourceId', 'sql', 'scenario'],
    'properties': {
        'dataSourceId': {'type': 'string'},
        'sql': {'type': 'string', 'description': '基准聚合 SQL（如看板固化图表的 sourceSql）'},
        'scenario': {'type': 'string', 'description': '情景描述（≤500 字）'},
        'question': {'type': 'string', 'description': '原始提问背景（可选）'},
    },
}

AGENT_PLAN_BODY = {
    'type': 'object',
    'required': ['question', 'dataSourceId'],
    'properties': {
        'question': {'type': 'string', 'description': '分析问题（≤500 字）'},
        'dataSourceId': {'type': 'string'},
    },
}

AGENT_RUN_BODY = {
    'type': 'object',
    'required': ['planId', 'dataSourceId'],
    'properties': {
        'planId': {'type': 'string', 'description': ' /api/agent/plan 返回的计划 ID（10 分钟有效、一次性消费）'},
        'dataSourceId': {'type': 'string'},
    },
}

NEW = OrderedDict({
    '/api/analytics/forecast': {
        'post': op('Analytics', 'forecastSeries',
                   'P1-5 时序预测：统计模型（移动平均/线性回归/季节分解，auto 回测择优）出未来 N 期 + 波动区间 + LLM 解读',
                   ['BadRequest', 'Unauthorized', 'Forbidden', 'RateLimited'],
                   body=FORECAST_BODY),
    },
    '/api/analytics/attribution': {
        'post': op('Analytics', 'attributeDelta',
                   'P1-6 多维归因：按维度组合贡献度拆解（正=拉高/负=拉低）自动排序 + LLM 结论',
                   ['BadRequest', 'Unauthorized', 'Forbidden', 'RateLimited'],
                   body=ATTRIBUTION_BODY),
    },
    '/api/analytics/whatif': {
        'post': op('Analytics', 'whatIfScenario',
                   'P1-9 情景推演：LLM 按场景改写既有 SQL → 安全校验 → 与原 SQL 对比执行 → LLM 解读',
                   ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'RateLimited'],
                   body=WHATIF_BODY),
    },
    '/api/agent/plan': {
        'post': op('Agent', 'planAgentRun',
                   'P1-7 Agent 编排：Planner 生成多能力计划（query/forecast/attribution，只规划不执行，计划 10 分钟有效）',
                   ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'RateLimited'],
                   body=AGENT_PLAN_BODY),
    },
    '/api/agent/run': {
        'post': op('Agent', 'runAgentPlan',
                   'P1-7 Agent 编排：批准后顺序执行计划（query 步走真实问数链路，forecast/attribution 步对上游数据统计）',
                   ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'RateLimited'],
                   body=AGENT_RUN_BODY),
    },
})

# 插入位置：紧跟巡检端点之后（P0-1 之后的最新业务端点）
AFTER = OrderedDict({
    '/api/patrols/{patrolId}/runs': list(NEW.keys()),
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

# 新增 Analytics / Agent tag（不存在时追加）
existing_tags = [t.get('name') for t in doc.get('tags', [])]
for tag_name, desc in [
    ('Analytics', 'P1-5/6/9 高级分析（时序预测 / 多维归因 / 情景推演）'),
    ('Agent', 'P1-7 Agent 编排（Planner 规划 + Executor 逐步执行）'),
]:
    if 'tags' in doc and tag_name not in existing_tags:
        doc['tags'].append(OrderedDict([('name', tag_name), ('description', desc)]))

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('added: /api/analytics/forecast, /api/analytics/attribution, /api/analytics/whatif, /api/agent/plan, /api/agent/run (5 端点)')
