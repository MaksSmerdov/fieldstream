import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { loadDeviceRefs } from '@fieldstream/db';
import type { DeviceRef } from '@fieldstream/db';
import type { Logger } from '@fieldstream/nest-common';
import { LOGGER, POOL } from '../tokens.js';

const REFRESH_MS = 60_000;
const RETRY_MS = 3_000;

/** Идентификаторы приборов в базе по коду. Грузятся при старте и обновляются раз в минуту. */
@Injectable()
export class DeviceRefsService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly log: Logger;
  private refs: ReadonlyMap<string, DeviceRef> = new Map();
  private timer: NodeJS.Timeout | null = null;

  public constructor(@Inject(POOL) pool: pg.Pool, @Inject(LOGGER) log: Logger) {
    this.pool = pool;
    this.log = log;
  }

  public onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  public current(): ReadonlyMap<string, DeviceRef> {
    return this.refs;
  }

  public isLoaded(): boolean {
    return this.refs.size > 0;
  }

  /** Перечитывает топологию. Пока база недоступна при старте, пробует снова каждые несколько секунд. */
  private async refresh(): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        this.refs = await loadDeviceRefs(client);
      } finally {
        client.release();
      }
    } catch (error) {
      this.log.warn({ err: error }, 'не удалось прочитать топологию из базы');
      if (!this.isLoaded()) {
        setTimeout(() => {
          void this.refresh();
        }, RETRY_MS).unref();
      }
    }
  }
}
