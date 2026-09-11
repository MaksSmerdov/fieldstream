import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { LinesService } from '../lines/lines.service.js';
import { KafkaPublisher } from '../publish/kafka-publisher.js';

interface Readiness {
  readonly status: 'ready' | 'starting';
  readonly kafka: boolean;
  readonly lines: number;
  readonly buffered: number;
}

/** Живость и готовность. Готов, когда продюсер подключён и получен конфиг линий. */
@Controller('health')
export class HealthController {
  private readonly publisher: KafkaPublisher;
  private readonly lines: LinesService;

  public constructor(publisher: KafkaPublisher, lines: LinesService) {
    this.publisher = publisher;
    this.lines = lines;
  }

  @Get('live')
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  public ready(): Readiness {
    const kafka = this.publisher.isConnected();
    const lines = this.lines.lineCount();
    const readiness: Readiness = {
      status: kafka && lines > 0 ? 'ready' : 'starting',
      kafka,
      lines,
      buffered: this.publisher.bufferSize(),
    };

    if (readiness.status !== 'ready') throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
