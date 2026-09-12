import { Controller, Get, Inject } from '@nestjs/common';
import type pg from 'pg';
import type { BootResponse, BootStageView } from '@fieldstream/contracts';
import { loadBootFacts } from '@fieldstream/db';
import type { BootFacts } from '@fieldstream/db';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { Public } from '../auth/auth.guard.js';
import { withClient } from '../common/with-client.js';
import { CLOCK, POOL } from '../tokens.js';

/** Прибор считается живым, пока его последнему значению меньше минуты. */
const FRESH_LIMIT_SEC = 60;

const stagesOf = (facts: BootFacts): BootStageView[] => [
  {
    stage: 'topology',
    title: 'Стенд перенесён в базу',
    status: facts.devices > 0 ? 'done' : 'running',
    progressPct: facts.devices > 0 ? 100 : 0,
    detail: facts.devices > 0 ? `${String(facts.devices)} приборов` : 'миграции и топология',
  },
  {
    stage: 'history',
    title: 'История засеяна',
    status: facts.seededStage?.status ?? (facts.historyRows > 0 ? 'done' : 'pending'),
    progressPct: facts.seededStage?.progressPct ?? (facts.historyRows > 0 ? 100 : 0),
    detail: facts.seededStage?.detail ?? 'графики за неделю появятся после засева',
  },
  {
    stage: 'live',
    title: 'Поток телеметрии идёт',
    status:
      facts.freshReadingAgeSec !== null && facts.freshReadingAgeSec <= FRESH_LIMIT_SEC
        ? 'done'
        : 'running',
    progressPct: facts.freshReadingAgeSec !== null ? 100 : 0,
    detail:
      facts.freshReadingAgeSec === null
        ? 'ждём первые кадры с приборов'
        : `последнее значение ${String(facts.freshReadingAgeSec)} с назад`,
  },
];

/** Готовность стенда. Открыт без входа: панель видна до формы входа, телеметрии здесь нет. */
@Public()
@Controller('boot')
export class BootController {
  public constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  public async boot(): Promise<BootResponse> {
    const facts = await withClient(this.pool, (client) => loadBootFacts(client));
    const stages = stagesOf(facts);

    return {
      ready: stages.every((stage) => stage.status === 'done'),
      stages,
      serverTime: toIsoTimestamp(this.clock.now()),
    };
  }
}
