import { Controller, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { LiveBusService } from './live-bus.service.js';

/** Живой канал: одно соединение на вкладку, события приходят потоком, а не опросом. */
@Controller('events')
export class EventsController {
  public constructor(private readonly bus: LiveBusService) {}

  @Sse()
  public stream(): Observable<MessageEvent> {
    return this.bus.stream();
  }
}
