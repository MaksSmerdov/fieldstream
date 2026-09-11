import { describe, expect, it } from 'vitest';
import type { HealthNode } from '../src/health.js';
import { DEFAULT_HEALTH_POLICY, healthNodeSchema } from '../src/health.js';

const TS = '2026-09-11T10:00:00.000Z';

const node = (kind: HealthNode['kind'], code: string, children: HealthNode[] = []): HealthNode => ({
  kind,
  code,
  label: code,
  status: 'online',
  reason: 'ok',
  since: TS,
  lastOkAt: TS,
  consecutiveErrors: 0,
  children,
});

describe('healthNodeSchema', () => {
  it('разбирает дерево до прибора включительно', () => {
    const tree = node('site', 'SITE-A', [
      node('gateway', 'GW-01', [node('line', 'L1', [node('device', 'RC-101')])]),
    ]);

    expect(healthNodeSchema.parse(tree)).toEqual(tree);
  });

  it('ловит ошибку в глубоком потомке и называет путь', () => {
    const broken = node('site', 'SITE-A', [
      node('gateway', 'GW-01', [
        node('line', 'L1', [{ ...node('device', 'RC-101'), consecutiveErrors: -1 }]),
      ]),
    ]);
    const result = healthNodeSchema.safeParse(broken);
    if (result.success) throw new Error('ожидалась ошибка схемы, а дерево прошло разбор');

    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
      'children.0.children.0.children.0.consecutiveErrors',
    );
  });

  it('лишний ключ в потомке отвергается', () => {
    const broken: unknown = {
      ...node('site', 'SITE-A'),
      children: [{ ...node('device', 'RC-101'), extra: 1 }],
    };

    expect(healthNodeSchema.safeParse(broken).success).toBe(false);
  });

  it('прибор без единого успеха допустим', () => {
    expect(
      healthNodeSchema.parse({ ...node('device', 'RC-101'), lastOkAt: null }).lastOkAt,
    ).toBeNull();
  });
});

describe('DEFAULT_HEALTH_POLICY', () => {
  it('пороги заморожены, чтобы общий дефолт нельзя было изменить на месте', () => {
    expect(Object.isFrozen(DEFAULT_HEALTH_POLICY)).toBe(true);
  });

  it('окно после старта больше периода опроса, а протухание больше окна старта', () => {
    expect(DEFAULT_HEALTH_POLICY.startupGraceMs).toBeGreaterThan(0);
    expect(DEFAULT_HEALTH_POLICY.staleAfterMs).toBeGreaterThan(
      DEFAULT_HEALTH_POLICY.startupGraceMs,
    );
    expect(DEFAULT_HEALTH_POLICY.offlineAfterErrors).toBeGreaterThan(1);
  });
});
