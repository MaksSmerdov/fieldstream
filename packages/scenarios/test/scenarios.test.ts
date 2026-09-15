import { describe, expect, it } from 'vitest';
import { loadScenario, loadScenarios } from '../src/loader.js';
import { describeStep } from '../src/titles.js';

describe('сценарии стенда', () => {
  it('все шесть загружаются без ошибок', async () => {
    const scenarios = await loadScenarios();

    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      'crc-garbage',
      'dead-device',
      'gateway-down',
      'line-blackout',
      'night-defrost-quiet',
      'offscale-alarm',
    ]);
  });

  it('каждая внесённая поломка снимается шагом clear позже', async () => {
    for (const scenario of await loadScenarios()) {
      scenario.steps.forEach((step, index) => {
        if (step.kind !== 'inject') return;
        const { targetId, kind } = step.request;
        const cleared = scenario.steps
          .slice(index + 1)
          .some(
            (later) =>
              later.kind === 'clear' &&
              later.filter.targetId === targetId &&
              later.filter.kind === kind,
          );

        expect(cleared, `${scenario.name}: ${targetId} ${kind}`).toBe(true);
      });
    }
  });

  it('dead-device читается по-человечески', async () => {
    const scenario = await loadScenario('dead-device');

    expect(scenario.steps.map(describeStep)).toEqual([
      'Запомнить среднюю длительность обхода линии L2 по 3 обходам как «l2-cycle»',
      'Внести поломку «молчит» на RC-105 на 360 с',
      'Дождаться, пока размыкатель RC-105 разомкнётся, не дольше 45 с',
      'Дождаться, пока прибор RC-104 выйдет на связь, не дольше 30 с',
      'Дождаться, пока линия L2 уложит обход в базовый «l2-cycle» плюс 15%, не дольше 30 с',
      'Снять поломку «молчит» с RC-105',
      'Дождаться, пока размыкатель RC-105 замкнётся, не дольше 120 с',
      'Дождаться, пока прибор RC-105 выйдет на связь, не дольше 60 с',
    ]);
  });

  it('заголовки остальных видов шагов', async () => {
    const [crc, offscale, defrost, blackout] = await Promise.all(
      ['crc-garbage', 'offscale-alarm', 'night-defrost-quiet', 'line-blackout'].map((name) =>
        loadScenario(name),
      ),
    );

    expect(crc?.steps.map(describeStep)[2]).toBe(
      'Проверять 20 с, что очередь недоставленных не растёт',
    );
    expect(offscale?.steps.map(describeStep)).toEqual([
      'Внести поломку «значение за шкалой» (supply_temp_c) на RC-102 на 240 с',
      'Дождаться, пока по RC-102 поднимется аларм supply_temp_c, не дольше 120 с',
      'Снять поломку «значение за шкалой» с RC-102',
      'Дождаться, пока по RC-102 не останется активных алармов по supply_temp_c, не дольше 60 с',
    ]);
    expect(defrost?.steps.map(describeStep)).toEqual([
      'Запустить сценарий стенда «ночная оттайка»',
      'Дождаться, пока прибор RC-101 перейдёт в режим «оттайка», не дольше 30 с',
      'Проверять 300 с, что не поднимаются новые алармы по evap_temp_c',
    ]);
    expect(blackout?.steps.map(describeStep).slice(0, 3)).toEqual([
      'Внести поломку «обрыв порта» на линию L3 на 540 с',
      'Дождаться, пока линия L3 отключится, не дольше 15 с',
      'Дождаться, пока линия L3 отключится, наберёт с начала прогона не меньше 3 попыток переподключения, не дольше 30 с',
    ]);
  });
});
