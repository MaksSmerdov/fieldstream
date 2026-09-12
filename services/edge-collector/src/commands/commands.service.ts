import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { TOPICS } from '@fieldstream/contracts';
import type { CommandResult, CommandStatus, DeviceCommand } from '@fieldstream/contracts';
import { DEMO_STAND } from '@fieldstream/device-profiles';
import { toIsoTimestamp } from '@fieldstream/domain';
import type { Clock } from '@fieldstream/domain';
import { createConsumer, decodeMessage } from '@fieldstream/kafka';
import type { Logger } from '@fieldstream/nest-common';
import { LinesService } from '../lines/lines.service.js';
import { KafkaPublisher } from '../publish/kafka-publisher.js';
import { CLOCK, LOGGER } from '../tokens.js';

export const COMMANDS_GROUP = 'fs-collector-commands';

/** Площадка линии по стенду: сборщик обслуживает только свои и чужие команды не трогает. */
const siteOfLine = (lineCode: string): string | null => {
  const line = DEMO_STAND.lines.find((candidate) => candidate.code === lineCode);
  const gateway = DEMO_STAND.gateways.find((candidate) => candidate.code === line?.gatewayCode);

  return gateway?.siteCode ?? null;
};

/**
 * Команды операторов. Повтор безвреден, поэтому защиты сложнее проверки срока здесь нет.
 * Ответ уходит обратно в брокер: сборщик стоит за NAT и про базу не знает.
 */
@Injectable()
export class CommandsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: Consumer;
  private running = false;

  public constructor(
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly lines: LinesService,
    private readonly publisher: KafkaPublisher,
  ) {
    this.consumer = createConsumer(publisher.kafka, COMMANDS_GROUP);
  }

  public onApplicationBootstrap(): void {
    void this.start();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.consumer.disconnect();
  }

  public isRunning(): boolean {
    return this.running;
  }

  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: TOPICS.deviceCommands.name, fromBeginning: false });
      await this.consumer.run({ eachMessage: (payload) => this.handle(payload) });
      this.running = true;
      this.log.info({ group: COMMANDS_GROUP }, 'приём команд включён');
    } catch (error) {
      this.log.warn({ err: error }, 'приём команд не поднялся, повтор через несколько секунд');
      setTimeout(() => {
        void this.start();
      }, 5_000).unref();
    }
  }

  private handle(payload: EachMessagePayload): Promise<void> {
    const decoded = decodeMessage(
      TOPICS.deviceCommands,
      payload.message.value,
      payload.message.headers,
    );
    if (!decoded.ok) {
      this.log.warn({ error: decoded.error }, 'команда не разбирается схемой, пропущена');
      return Promise.resolve();
    }

    const command = decoded.payload;
    if (!this.lines.owns(command.lineCode)) return Promise.resolve();
    if (siteOfLine(command.lineCode) !== command.siteCode) {
      this.report(command, 'rejected', 'площадка команды не совпадает со стендом');
      return Promise.resolve();
    }
    if (Date.parse(command.expiresAt) <= this.clock.now()) {
      this.report(command, 'expired', 'срок команды истёк, применять её поздно');
      return Promise.resolve();
    }

    const outcome = this.apply(command);
    this.report(command, outcome.status, outcome.detail);

    return Promise.resolve();
  }

  private apply(command: DeviceCommand): { status: CommandStatus; detail: string } {
    switch (command.kind) {
      case 'line.enable':
        this.lines.enable(command.lineCode);
        return { status: 'applied', detail: `опрос линии ${command.lineCode} включён` };

      case 'line.disable':
        this.lines.disable(command.lineCode);
        return { status: 'applied', detail: `опрос линии ${command.lineCode} остановлен` };

      case 'line.set_poll_interval': {
        const interval = command.args.pollIntervalMs;
        if (interval === undefined) return { status: 'rejected', detail: 'не задан такт опроса' };
        this.lines.setPollInterval(command.lineCode, interval);
        return {
          status: 'applied',
          detail: `такт опроса линии ${command.lineCode} теперь ${String(interval)} мс`,
        };
      }

      case 'line.plan_mode': {
        const mode = command.args.planMode;
        if (mode === undefined)
          return { status: 'rejected', detail: 'не задан режим плана чтения' };
        this.lines.setPlanMode(command.lineCode, mode);
        return {
          status: 'applied',
          detail: `план чтения линии ${command.lineCode} теперь ${mode}`,
        };
      }
    }
  }

  private report(command: DeviceCommand, status: CommandStatus, detail: string): void {
    const result: CommandResult = {
      schema: 'device.command.result',
      v: 1,
      commandId: command.commandId,
      siteCode: command.siteCode,
      lineCode: command.lineCode,
      kind: command.kind,
      status,
      detail,
      appliedAt: toIsoTimestamp(this.clock.now()),
      traceId: command.traceId,
    };

    this.publisher.publish(TOPICS.commandResults, result, result.traceId);
    this.log.info({ commandId: command.commandId, status, detail }, 'команда обработана');
  }
}
