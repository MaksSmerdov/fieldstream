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
import { z } from 'zod';
import { LinesService } from '../lines/lines.service.js';
import type { LineSnapshot } from '../polling/line-worker.js';

const planModeRequestSchema = z.object({ mode: z.enum(['merged', 'naive']) }).strict();

/** Внутренний API: состояние воркеров и переключение режима плана чтения для демонстрации. */
@Controller('internal/lines')
export class InternalController {
  private readonly lines: LinesService;

  public constructor(lines: LinesService) {
    this.lines = lines;
  }

  @Get()
  public list(): LineSnapshot[] {
    return this.lines.snapshot();
  }

  @Post(':lineCode/plan-mode')
  @HttpCode(200)
  public setPlanMode(
    @Param('lineCode') lineCode: string,
    @Body() body: unknown,
  ): { lineCode: string; mode: 'merged' | 'naive' } {
    const parsed = planModeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    if (!this.lines.setPlanMode(lineCode, parsed.data.mode)) {
      throw new NotFoundException(`линии ${lineCode} у этого сборщика нет`);
    }
    return { lineCode, mode: parsed.data.mode };
  }
}
