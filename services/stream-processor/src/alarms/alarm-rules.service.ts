import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import type { AlarmRule } from '@fieldstream/contracts';
import { loadAlarmRules } from '@fieldstream/db';
import type { Logger } from '@fieldstream/nest-common';
import type { Env } from '../config/env.js';
import { ENV, LOGGER, POOL } from '../tokens.js';

const RETRY_MS = 3_000;
const NONE: readonly AlarmRule[] = Object.freeze([]);

/**
 * Уставки приборов. Перечитываются раз в несколько секунд, поэтому правка в интерфейсе
 * меняет поведение алармов без перезапуска процессора и без оповещений через брокер.
 */
@Injectable()
export class AlarmRulesService implements OnModuleInit, OnModuleDestroy {
  private byDevice: ReadonlyMap<string, readonly AlarmRule[]> = new Map();
  private total = 0;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  public onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.env.ALARM_RULES_REFRESH_MS);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  public forDevice(deviceCode: string): readonly AlarmRule[] {
    return this.byDevice.get(deviceCode) ?? NONE;
  }

  public count(): number {
    return this.total;
  }

  private async refresh(): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        const rules = await loadAlarmRules(client);
        const byDevice = new Map<string, AlarmRule[]>();
        for (const rule of rules) {
          const list = byDevice.get(rule.deviceCode);
          if (list === undefined) byDevice.set(rule.deviceCode, [rule]);
          else list.push(rule);
        }
        this.byDevice = byDevice;
        this.total = rules.length;
      } finally {
        client.release();
      }
    } catch (error) {
      this.log.warn({ err: error }, 'не удалось прочитать уставки алармов');
      if (this.total === 0) {
        setTimeout(() => {
          void this.refresh();
        }, RETRY_MS).unref();
      }
    }
  }
}
