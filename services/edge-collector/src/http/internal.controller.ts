import { Controller, Get } from '@nestjs/common';
import { LinesService } from '../lines/lines.service.js';
import type { LineSnapshot } from '../polling/line-worker.js';

/** Внутренний API: состояние воркеров линий. */
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
}
