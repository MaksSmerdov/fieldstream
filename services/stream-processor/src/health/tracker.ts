import type {
  DeviceEvent,
  DeviceMode,
  DeviceState,
  HealthNode,
  HealthPolicy,
  HealthStatus,
  PollCycle,
  Stand,
} from '@fieldstream/contracts';
import { buildHealthTree, detectDeviceEvents } from '@fieldstream/domain';
import type { Clock, DeviceSnapshot, HealthSnapshot, SiteHealthInput } from '@fieldstream/domain';
import type { FrameObservation } from '../ingest/frame.js';

interface DeviceTrack {
  lastOkAtMs: number | null;
  consecutiveErrors: number;
  mode: DeviceMode;
  doorOpen: boolean | null;
  defrostActive: boolean | null;
  health: HealthSnapshot | null;
  status: HealthStatus;
  snapshot: DeviceSnapshot | null;
  published: string | null;
}

export interface HealthEvaluation {
  readonly states: readonly DeviceState[];
  readonly events: readonly DeviceEvent[];
}

/** Наблюдения по кадрам одной пачки: применяются к трекеру только после записи. */
export interface FrameDraft {
  readonly observe: (observation: FrameObservation) => DeviceEvent[];
  readonly commit: () => void;
}

/** Здоровье приборов: отказы и успехи из циклов опроса, режим и двери из кадров. */
export interface HealthTracker {
  readonly observeCycle: (cycle: PollCycle) => void;
  readonly draftFrames: () => FrameDraft;
  readonly evaluate: () => HealthEvaluation;
  readonly confirmPublished: (states: readonly DeviceState[]) => void;
}

export interface HealthTrackerOptions {
  readonly stand: Stand;
  readonly clock: Clock;
  readonly policy: HealthPolicy;
}

/** По этим полям решается, изменилось ли состояние: время последнего успеха меняется каждый цикл. */
const signatureOf = (state: DeviceState): string => `${state.status}|${state.reason}|${state.mode}`;

/** Листья дерева здоровья: узлы приборов. */
const deviceNodes = (node: HealthNode): HealthNode[] =>
  node.kind === 'device' ? [node] : node.children.flatMap(deviceNodes);

/**
 * Трекер здоровья. Состояние прибора публикуется только при смене статуса, причины или режима,
 * и пока публикация не подтверждена, оно предлагается снова. События двери и оттайки получают
 * время кадра, а переходы статуса время проверки: другого честного момента у них нет.
 */
export const createHealthTracker = (options: HealthTrackerOptions): HealthTracker => {
  const { stand, clock, policy } = options;
  const startedAtMs = clock.now();
  const tracks = new Map<string, DeviceTrack>(
    stand.devices.map((device) => [
      device.code,
      {
        lastOkAtMs: null,
        consecutiveErrors: 0,
        mode: 'cooling',
        doorOpen: null,
        defrostActive: null,
        health: null,
        status: 'unknown',
        snapshot: null,
        published: null,
      },
    ]),
  );

  const snapshotEvents = (deviceCode: string, track: DeviceTrack, atMs: number): DeviceEvent[] => {
    const current: DeviceSnapshot = {
      deviceCode,
      atMs,
      status: track.status,
      mode: track.mode,
      doorOpen: track.doorOpen,
      defrostActive: track.defrostActive,
    };
    const events = detectDeviceEvents(track.snapshot, current);
    track.snapshot = current;
    return events;
  };

  const siteInput = (siteCode: string, label: string): SiteHealthInput => ({
    code: siteCode,
    label,
    prev: null,
    gateways: stand.gateways
      .filter((gateway) => gateway.siteCode === siteCode)
      .map((gateway) => ({
        code: gateway.code,
        label: gateway.code,
        prev: null,
        lines: stand.lines
          .filter((line) => line.gatewayCode === gateway.code)
          .map((line) => ({
            code: line.code,
            label: line.code,
            pollingEnabled: true,
            prev: null,
            devices: stand.devices
              .filter((device) => device.lineCode === line.code)
              .map((device) => {
                const track = tracks.get(device.code);
                return {
                  code: device.code,
                  label: device.code,
                  lastOkAtMs: track?.lastOkAtMs ?? null,
                  consecutiveErrors: track?.consecutiveErrors ?? 0,
                  prev: track?.health ?? null,
                };
              }),
          })),
      })),
  });

  return {
    observeCycle: (cycle) => {
      const track = tracks.get(cycle.deviceCode);
      if (track === undefined) return;
      if (cycle.ok) {
        track.lastOkAtMs = Date.parse(cycle.ts);
        track.consecutiveErrors = 0;
      } else {
        track.consecutiveErrors += 1;
      }
    },
    draftFrames: () => {
      const draft = new Map<string, DeviceSnapshot>();
      return {
        observe: (observation) => {
          const track = tracks.get(observation.deviceCode);
          if (track === undefined) return [];
          const current: DeviceSnapshot = {
            deviceCode: observation.deviceCode,
            atMs: observation.atMs,
            status: track.status,
            mode: observation.mode,
            doorOpen: observation.doorOpen,
            defrostActive: observation.defrostActive,
          };
          const prev = draft.get(observation.deviceCode) ?? track.snapshot;
          draft.set(observation.deviceCode, current);
          return detectDeviceEvents(prev, current);
        },
        commit: () => {
          for (const [deviceCode, snapshot] of draft) {
            const track = tracks.get(deviceCode);
            if (track === undefined) continue;
            track.mode = snapshot.mode;
            track.doorOpen = snapshot.doorOpen;
            track.defrostActive = snapshot.defrostActive;
            track.snapshot = { ...snapshot, status: track.status };
          }
        },
      };
    },
    evaluate: () => {
      const nowMs = clock.now();
      const states: DeviceState[] = [];
      const events: DeviceEvent[] = [];

      for (const site of stand.sites) {
        const tree = buildHealthTree({
          site: siteInput(site.code, site.name),
          policy,
          startedAtMs,
          nowMs,
        });

        for (const node of deviceNodes(tree)) {
          const track = tracks.get(node.code);
          if (track === undefined) continue;

          track.health = { status: node.status, sinceMs: Date.parse(node.since) };
          track.status = node.status;
          events.push(...snapshotEvents(node.code, track, nowMs));

          const state: DeviceState = {
            schema: 'device.state',
            v: 1,
            deviceCode: node.code,
            status: node.status,
            reason: node.reason,
            since: node.since,
            mode: track.mode,
            lastOkAt: node.lastOkAt,
            consecutiveErrors: node.consecutiveErrors,
          };
          if (signatureOf(state) !== track.published) states.push(state);
        }
      }

      return { states, events };
    },
    confirmPublished: (states) => {
      for (const state of states) {
        const track = tracks.get(state.deviceCode);
        if (track !== undefined) track.published = signatureOf(state);
      }
    },
  };
};
