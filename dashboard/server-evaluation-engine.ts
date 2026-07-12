import type {
  EvaluationAssertion,
  EvaluationCase,
  EvaluationMetricDefinition,
  EvaluationRubric,
} from './server-evaluation-store.ts';

export type EvaluationMetricResult = {
  key: string;
  label: string;
  score: number;
  weight: number;
  passed: boolean;
  required: boolean;
  applied: boolean;
  evidence: string;
};

export type QaEvaluationResult = {
  score: number;
  passed: boolean;
  metrics: EvaluationMetricResult[];
};

function normalizeText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}

function deepEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function jsonPath(root: unknown, pathValue: string) {
  const path = pathValue.trim().replace(/^\$\.?/, '');
  if (!path) return root;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function assertionResult(assertion: EvaluationAssertion, output: string) {
  const normalizedOutput = normalizeText(output);
  if (assertion.type === 'exact') {
    const expected = normalizeText(assertion.value || '');
    const passed = Boolean(expected) && normalizedOutput === expected;
    return { passed, evidence: passed ? '与标准答案归一化匹配' : '未与标准答案完全匹配' };
  }
  if (assertion.type === 'required_keyword') {
    const values = (assertion.values?.length ? assertion.values : [assertion.value || '']).filter(Boolean);
    const missing = values.filter(value => !normalizedOutput.includes(normalizeText(value)));
    return {
      passed: values.length > 0 && missing.length === 0,
      evidence: missing.length ? `缺少关键词: ${missing.join('、')}` : `包含 ${values.length} 个必需关键词`,
    };
  }
  if (assertion.type === 'forbidden_keyword') {
    const values = (assertion.values?.length ? assertion.values : [assertion.value || '']).filter(Boolean);
    const found = values.filter(value => normalizedOutput.includes(normalizeText(value)));
    return {
      passed: found.length === 0,
      evidence: found.length ? `出现禁用关键词: ${found.join('、')}` : '未出现禁用关键词',
    };
  }
  if (assertion.type === 'regex') {
    const pattern = assertion.value || '';
    if (!pattern || pattern.length > 500) return { passed: false, evidence: '正则为空或超过 500 字符' };
    try {
      const flags = (assertion.flags || '').replace(/g/g, '');
      const passed = new RegExp(pattern, flags).test(output.slice(0, 100_000));
      return { passed, evidence: passed ? `匹配正则 /${pattern}/${flags}` : `未匹配正则 /${pattern}/${flags}` };
    } catch (error) {
      return { passed: false, evidence: `正则无效: ${(error as Error).message}` };
    }
  }
  try {
    const parsed = JSON.parse(output);
    const actual = jsonPath(parsed, assertion.path || '');
    const passed = deepEqual(actual, assertion.expected);
    return {
      passed,
      evidence: passed
        ? `JSON ${assertion.path || '$'} 与期望一致`
        : `JSON ${assertion.path || '$'} 实际值 ${JSON.stringify(actual)}，期望 ${JSON.stringify(assertion.expected)}`,
    };
  } catch (error) {
    return { passed: false, evidence: `回答不是有效 JSON: ${(error as Error).message}` };
  }
}

function metricForAssertion(metric: EvaluationMetricDefinition, assertions: EvaluationAssertion[], output: string): EvaluationMetricResult {
  const relevant = assertions.filter(assertion => assertion.type === metric.key);
  if (!metric.enabled || relevant.length === 0) {
    return {
      key: metric.key,
      label: metric.label,
      score: 0,
      weight: metric.weight,
      passed: true,
      required: Boolean(metric.required),
      applied: false,
      evidence: '本用例未配置该指标',
    };
  }
  let earned = 0;
  let possible = 0;
  const evidence: string[] = [];
  let requiredFailure = false;
  for (const assertion of relevant) {
    const weight = Math.max(0, Number(assertion.weight || 1));
    const result = assertionResult(assertion, output);
    possible += weight;
    if (result.passed) earned += weight;
    if ((assertion.required || metric.required) && !result.passed) requiredFailure = true;
    evidence.push(result.evidence);
  }
  const score = possible > 0 ? (earned / possible) * 100 : 0;
  return {
    key: metric.key,
    label: metric.label,
    score,
    weight: metric.weight,
    passed: !requiredFailure && score >= 100,
    required: Boolean(metric.required || relevant.some(assertion => assertion.required)),
    applied: true,
    evidence: evidence.join('；'),
  };
}

export function evaluateQaAnswer(evaluationCase: EvaluationCase, output: string, rubric: EvaluationRubric): QaEvaluationResult {
  const assertions = [...evaluationCase.assertions];
  if (evaluationCase.expectedAnswer && !assertions.some(assertion => assertion.type === 'exact')) {
    assertions.unshift({ type: 'exact', value: evaluationCase.expectedAnswer, weight: 1 });
  }
  const metrics = rubric.metrics.map(metric => metricForAssertion(metric, assertions, output));
  const applied = metrics.filter(metric => metric.applied && metric.weight > 0);
  const totalWeight = applied.reduce((sum, metric) => sum + metric.weight, 0);
  const score = totalWeight > 0
    ? applied.reduce((sum, metric) => sum + metric.score * metric.weight, 0) / totalWeight
    : 0;
  const hardFailure = metrics.some(metric => metric.applied && metric.required && !metric.passed);
  return {
    score,
    passed: !hardFailure && score >= rubric.passThreshold,
    metrics,
  };
}

export function buildJudgePrompt(input: {
  evaluationCase: EvaluationCase;
  output: string;
  metrics: EvaluationMetricResult[];
  rubric: EvaluationRubric;
}) {
  const metricSummary = input.metrics
    .filter(metric => metric.applied)
    .map(metric => `- ${metric.label}: ${metric.score.toFixed(1)} / 100；证据：${metric.evidence}`)
    .join('\n');
  return [
    input.rubric.judgePrompt || '请依据题目、参考材料与自动验证证据，对候选回答进行独立评分。',
    '',
    '评分要求：',
    '- 只评估回答质量，不猜测候选身份、模型或来源。',
    '- score 为 0–100。confidence 为 0–1。',
    '- reasoning 必须引用回答或参考材料中的具体证据。',
    '',
    `题目：\n${input.evaluationCase.prompt}`,
    input.evaluationCase.referenceMaterial ? `\n参考材料：\n${input.evaluationCase.referenceMaterial}` : '',
    input.evaluationCase.expectedAnswer ? `\n标准答案：\n${input.evaluationCase.expectedAnswer}` : '',
    `\n候选回答：\n${input.output}`,
    metricSummary ? `\n自动验证：\n${metricSummary}` : '\n自动验证：本用例没有可用自动断言。',
  ].filter(Boolean).join('\n');
}

export const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'number', minimum: 0, maximum: 100 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' },
  },
  required: ['score', 'confidence', 'reasoning'],
} as const;
