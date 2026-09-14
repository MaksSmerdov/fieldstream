import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenario, loadScenarios, parseScenario, ScenarioLoadError } from '../src/loader.js';

const header = (timeoutSec = 120, name = 'sample'): string =>
  [
    `name: ${name}`,
    'title: Проба',
    'description: Проверка схемы',
    `timeoutSec: ${timeoutSec}`,
    'steps:',
  ].join('\n');

const yamlOf = (steps: string, timeoutSec = 120): string => `${header(timeoutSec)}\n${steps}\n`;

const issuesOf = (text: string, fileName = 'sample.yaml'): readonly string[] => {
  const result = parseScenario(fileName, text);
  if (result.ok) throw new Error('ожидался отказ схемы');
  return result.issues;
};

describe('схема сценария', () => {
  it('разбирает шаги в записи с полем kind и подставляет умолчания поломки', () => {
    const result = parseScenario(
      'sample.yaml',
      yamlOf(
        [
          '  - baseline: { line: L2, samples: 3, as: l2-cycle }',
          '  - inject: { targetKind: device, targetId: RC-105, kind: silent }',
          '  - waitFor:',
          '      probe: { line: { lineCode: L2, durationWithinPct: { of: l2-cycle, pct: 15 } } }',
          '      timeoutSec: 30',
          '  - hold: { probe: { dlqUnchanged: true }, forSec: 20 }',
          '  - clear:',
          '  - simScenario: night-defrost',
        ].join('\n'),
      ),
    );

    if (!result.ok) throw new Error(result.issues.join('\n'));
    const [baseline, inject, waitFor, hold, clear, simScenario] = result.scenario.steps;

    expect(baseline).toEqual({ kind: 'baseline', line: 'L2', samples: 3, as: 'l2-cycle' });
    expect(inject).toEqual({
      kind: 'inject',
      request: {
        targetKind: 'device',
        targetId: 'RC-105',
        kind: 'silent',
        ttlSec: 300,
        exceptionCode: 4,
      },
    });
    expect(waitFor).toEqual({
      kind: 'waitFor',
      timeoutSec: 30,
      probe: { kind: 'line', lineCode: 'L2', durationWithinPct: { of: 'l2-cycle', pct: 15 } },
    });
    expect(hold).toEqual({ kind: 'hold', forSec: 20, probe: { kind: 'dlqUnchanged' } });
    expect(clear).toEqual({ kind: 'clear', filter: {} });
    expect(simScenario).toEqual({ kind: 'simScenario', name: 'night-defrost' });
  });

  it('неизвестный шаг', () => {
    expect(issuesOf(yamlOf('  - jump: { to: L1 }'))).toEqual([
      'sample.yaml: steps.0.jump: шаг: неизвестный вид «jump», ожидается один из inject, clear, simScenario, baseline, waitFor, hold',
    ]);
  });

  it('два ключа в шаге', () => {
    expect(
      issuesOf(
        yamlOf(
          [
            '  - inject: { targetKind: device, targetId: RC-105, kind: silent }',
            '    clear: { targetId: RC-105 }',
          ].join('\n'),
        ),
      ),
    ).toEqual(['sample.yaml: steps.0: шаг: нужен ровно один ключ, а заданы inject, clear']);
  });

  it('два ключа в пробе и проба прибора без условий', () => {
    const issues = issuesOf(
      yamlOf(
        [
          '  - waitFor:',
          '      probe: { breaker: { deviceCode: RC-105, state: open }, dlqUnchanged: true }',
          '      timeoutSec: 10',
          '  - waitFor: { probe: { device: { deviceCode: RC-105 } }, timeoutSec: 10 }',
        ].join('\n'),
      ),
    );

    expect(issues).toEqual([
      'sample.yaml: steps.0.waitFor.probe: проба: нужен ровно один ключ, а заданы breaker, dlqUnchanged',
      'sample.yaml: steps.1.waitFor.probe.device: проба прибора: нужно хотя бы одно из status, reason, mode',
    ]);
  });

  it('ссылка на необъявленный baseline', () => {
    const probe =
      '  - waitFor: { probe: { line: { lineCode: L2, durationWithinPct: { of: l2-cycle, pct: 15 } } }, timeoutSec: 30 }';
    const expected =
      'sample.yaml: steps.0.waitFor.probe.line.durationWithinPct.of: базовая длительность «l2-cycle» не объявлена в шагах выше';

    expect(issuesOf(yamlOf(probe))).toEqual([expected]);
    expect(
      issuesOf(yamlOf([probe, '  - baseline: { line: L2, samples: 3, as: l2-cycle }'].join('\n'))),
    ).toEqual([expected]);
  });

  it('повтор имени baseline', () => {
    expect(
      issuesOf(
        yamlOf(
          [
            '  - baseline: { line: L2, samples: 3, as: cycle }',
            '  - baseline: { line: L3, samples: 3, as: cycle }',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'sample.yaml: steps.1.baseline.as: базовая длительность «cycle» уже объявлена выше',
    ]);
  });

  it('оттайка в inject и правила поломок стенда', () => {
    expect(
      issuesOf(yamlOf('  - inject: { targetKind: device, targetId: RC-101, kind: defrost }')),
    ).toEqual([
      'sample.yaml: steps.0.inject.kind: оттайка не поломка со сроком: её запускает шаг simScenario: night-defrost',
    ]);
    expect(
      issuesOf(yamlOf('  - inject: { targetKind: device, targetId: RC-101, kind: offline }')),
    ).toEqual(['sample.yaml: steps.0.inject.kind: поломка "offline" вносится только на линию']);
  });

  it('имя не совпадает с файлом', () => {
    expect(issuesOf(yamlOf('  - clear: {}'), 'other.yaml')).toEqual([
      'other.yaml: name: «sample» не совпадает с именем файла, ожидается «other»',
    ]);
  });

  it('чужое имя видно вместе с другими ошибками схемы', () => {
    expect(issuesOf(`${header(120, 'y')}\n  - jump: {}\n`, 'x.yaml')).toEqual([
      'x.yaml: name: «y» не совпадает с именем файла, ожидается «x»',
      'x.yaml: steps.0.jump: шаг: неизвестный вид «jump», ожидается один из inject, clear, simScenario, baseline, waitFor, hold',
    ]);
  });

  it('ожидания не помещаются в общий предел', () => {
    expect(
      issuesOf(yamlOf('  - waitFor: { probe: { dlqUnchanged: true }, timeoutSec: 90 }', 60)),
    ).toEqual([
      'sample.yaml: steps.0.waitFor.timeoutSec: ожидание 90 с больше общего предела сценария 60 с',
      'sample.yaml: timeoutSec: сумма ожиданий шагов 90 с больше общего предела 60 с',
    ]);
    expect(
      issuesOf(
        yamlOf(
          [
            '  - waitFor: { probe: { dlqUnchanged: true }, timeoutSec: 40 }',
            '  - hold: { probe: { dlqUnchanged: true }, forSec: 40 }',
          ].join('\n'),
          60,
        ),
      ),
    ).toEqual(['sample.yaml: timeoutSec: сумма ожиданий шагов 80 с больше общего предела 60 с']);
  });

  it('битая разметка YAML', () => {
    const [issue] = issuesOf(`${header()}\n  - clear: {\n`);
    expect(issue).toMatch(/^sample\.yaml: строка \d+: разметка YAML не разбирается: /);
  });
});

describe('загрузка каталога', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('собирает ошибки всех файлов с их именами', async () => {
    dir = await mkdtemp(join(tmpdir(), 'scenarios-'));
    await writeFile(join(dir, 'sample.yaml'), yamlOf('  - clear: {}'));
    await writeFile(join(dir, 'broken.yaml'), yamlOf('  - jump: {}'));
    await writeFile(join(dir, 'notes.txt'), 'не сценарий');
    const url = pathToFileURL(`${dir}/`);

    const error = await loadScenarios(url).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScenarioLoadError);
    expect((error as ScenarioLoadError).issues).toEqual([
      'broken.yaml: name: «sample» не совпадает с именем файла, ожидается «broken»',
      'broken.yaml: steps.0.jump: шаг: неизвестный вид «jump», ожидается один из inject, clear, simScenario, baseline, waitFor, hold',
    ]);
    await expect(loadScenario('sample', url)).resolves.toMatchObject({ name: 'sample' });
    await expect(loadScenario('missing', url)).rejects.toThrow(
      'missing.yaml: сценария «missing» нет',
    );
    await expect(loadScenario('../sample', url)).rejects.toThrow(
      'имя сценария пишется в kebab-case',
    );
  });
});
