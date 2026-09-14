import { describe, expect, it } from 'vitest';
import { lineStatusSchema, pollCycleSchema, telemetryRawSchema } from '@fieldstream/contracts';
import { DEMO_STAND, rc2000Profile } from '@fieldstream/device-profiles';
import {
  buildLineStatus,
  buildPollCycle,
  buildRawFrame,
  newTraceId,
} from '../../src/polling/frames.js';
import type { DeviceContext } from '../../src/polling/frames.js';
import { summarizeLatency } from '../../src/polling/latency.js';

const device = DEMO_STAND.devices.find((candidate) => candidate.code === 'RC-104');
if (device === undefined) throw new Error('на стенде нет RC-104');

const CONTEXT: DeviceContext = {
  siteCode: 'SITE-A',
  gatewayCode: 'GW-01',
  lineCode: 'L2',
  device,
  profile: rc2000Profile,
};
const AT = Date.parse('2026-09-11T10:00:00Z');

describe('сообщения сборщика', () => {
  it('сырой кадр проходит схему топика и несёт версию профиля', () => {
    const frame = buildRawFrame(
      CONTEXT,
      [{ registerType: 'input', startAddress: 0, words: [65_350, 12, 7, 60] }],
      AT,
      41.6,
      newTraceId(),
    );

    expect(telemetryRawSchema.safeParse(frame).success).toBe(true);
    expect(frame).toMatchObject({
      deviceCode: 'RC-104',
      slaveId: 1,
      profileKey: 'rc-2000',
      profileVersion: 1,
      cycleMs: 42,
      ts: '2026-09-11T10:00:00.000Z',
    });
  });

  it('событие отказа проходит схему и несёт фактическую задержку и размыкатель', () => {
    const cycle = buildPollCycle(
      CONTEXT,
      {
        ok: false,
        errorKind: 'disconnected',
        durationMs: 3.2,
        requestCount: 0,
        planMode: 'merged',
        backoff: { baseMs: 2_000, jitterMs: -140, chosenMs: 1_860 },
        breaker: { state: 'open', nextProbeAt: AT + 30_000 },
      },
      AT,
      newTraceId(),
    );

    expect(pollCycleSchema.safeParse(cycle).success).toBe(true);
    expect(cycle.breaker).toEqual({ state: 'open', nextProbeAt: '2026-09-11T10:00:30.000Z' });
  });

  it('событие успеха без задержки и размыкателя тоже проходит схему', () => {
    const cycle = buildPollCycle(
      CONTEXT,
      { ok: true, errorKind: null, durationMs: 40, requestCount: 4, planMode: 'naive' },
      AT,
      newTraceId(),
    );

    expect(pollCycleSchema.safeParse(cycle).success).toBe(true);
    expect('backoff' in cycle).toBe(false);
  });

  it('снимок линии проходит схему топика, наступившая проба видна как half_open', () => {
    const status = buildLineStatus(
      {
        lineCode: 'L2',
        running: true,
        connected: false,
        planMode: 'merged',
        pollIntervalMs: 10_000,
        requestTimeoutMs: 600,
        cycleStartedAt: AT,
        watchdogLimitMs: 300_000,
        watchdogTrips: 1,
        lastCycle: {
          at: '2026-09-11T09:59:50.000Z',
          outcome: 'watchdog',
          durationMs: 300_000.4,
          polled: 0,
          failed: 0,
        },
        reconnects: [
          {
            attempt: 0,
            at: '2026-09-11T09:59:59.000Z',
            baseMs: 1_000,
            jitterMs: -40,
            chosenMs: 960,
          },
        ],
        devices: [
          { device, breaker: { failures: 2, open: true, probeDelayMs: 30_000, nextProbeAt: AT } },
        ],
        latency: summarizeLatency([{ kind: 'ok', durationMs: 42 }, { kind: 'timeout' }]),
      },
      AT,
    );

    expect(lineStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      hardTimeoutMs: 1_450,
      watchdog: { limitMs: 300_000, cycleStartedAt: '2026-09-11T10:00:00.000Z', trips: 1 },
      lastCycle: { durationMs: 300_000 },
    });
    expect(status.devices[0]?.breaker).toEqual({
      state: 'half_open',
      failures: 2,
      probeDelayMs: 30_000,
      nextProbeAt: '2026-09-11T10:00:00.000Z',
    });
  });

  it('идентификатор обхода: 16 шестнадцатеричных знаков, каждый раз новый', () => {
    const first = newTraceId();

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(newTraceId()).not.toBe(first);
  });
});
