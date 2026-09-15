import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { scenarioNameSchema, scenarioRunRequestSchema } from '@fieldstream/contracts';
import type { ScenarioRun, ScenariosResponse } from '@fieldstream/contracts';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/tokens.js';
import { ScenariosService } from './scenarios.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
export class ScenariosController {
  public constructor(private readonly scenarios: ScenariosService) {}

  /** Сценарии стенда с последними прогонами и прогон, который идёт сейчас. */
  @Get('scenarios')
  @RequirePermission('lab')
  public list(): Promise<ScenariosResponse> {
    return this.scenarios.list();
  }

  /**
   * Запуск прогона. Прогон вносит настоящие поломки и идёт минутами, поэтому исполняется в фоне:
   * ответ 202 с номером, ход читается по нему.
   */
  @Post('scenarios/:name/run')
  @HttpCode(202)
  @RequirePermission('scenarios.run')
  public async run(
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentUser() claims: AccessClaims,
  ): Promise<ScenarioRun> {
    if (!scenarioNameSchema.safeParse(name).success) {
      throw new NotFoundException(`сценария «${name}» нет`);
    }

    const parsed = scenarioRunRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    }

    return this.scenarios.start(name, parsed.data.source, claims.email);
  }

  /** Прогон с ходом по шагам. */
  @Get('scenario-runs/:id')
  @RequirePermission('lab')
  public async progress(@Param('id') id: string): Promise<ScenarioRun> {
    if (!UUID.test(id)) throw new BadRequestException('номер прогона это uuid');

    const run = await this.scenarios.load(id);
    if (run === null) throw new NotFoundException(`прогона ${id} нет`);

    return run;
  }
}
