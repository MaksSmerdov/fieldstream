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
import { buildHealthTree, detectDeviceEvents, toIsoTimestamp } from '@fieldstream/domain';
import type { Clock, DeviceSnapshot, HealthSnapshot, SiteHealthInput } from '@fieldstream/domain';
import type { FrameObservation } from '../ingest/frame.js';

/**
 * Что трекер знает о приборе. handoverAtMs это момент переезда прибора сюда со статусом online
 * из базы, graceFromMs начало его окна startup_grace, modeGuessed значит, что режим снимка взят
 * не из кадра. quiet у прибора, чьё состояние из базы прочитать не удалось: пока статус не выяснен,
 * прибор не публикуется, иначе догадка затёрла бы настоящее состояние прежнего владельца.
 */
interface DeviceTrack {
  lastOkAtMs: number | null;
  handoverAtMs: number | null;
  graceFromMs: number;
  consecutiveErrors: number;
  mode: DeviceMode;
  modeGuessed: boolean;
  quiet: boolean;
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

/**
 * Здоровье приборов: отказы и успехи из циклов опроса, режим и двери из кадров. Экземпляр ведёт
 * только свои приборы: отобранные при ребалансе уходят через release, а новые приходят через
 * adopt вместе с последним записанным состоянием, или с null, если его не удалось прочитать.
 */
export interface HealthTracker {
  readonly observeCycle: (cycle: PollCycle) => void;
  readonly draftFrames: () => FrameDraft;
  readonly evaluate: () => HealthEvaluation;
  readonly confirmPublished: (states: readonly DeviceState[]) => void;
  readonly owns: (deviceCode: string) => boolean;
  readonly release: (deviceCodes: readonly string[]) => void;
  readonly adopt: (deviceCodes: readonly string[], restored: readonly DeviceState[] | null) => void;
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

/** Трек прибора, о котором ещё ничего не известно. Окно startup_grace идёт от graceFromMs. */
const freshTrack = (graceFromMs: number): DeviceTrack => ({
  lastOkAtMs: null,
  handoverAtMs: null,
  graceFromMs,
  consecutiveErrors: 0,
  mode: 'cooling',
  modeGuessed: false,
  quiet: false,
  doorOpen: null,
  defrostActive: null,
  health: null,
  status: 'unknown',
  snapshot: null,
  published: null,
});

/**
 * Трек прибора, чьё состояние в базе прочитать не удалось. Строка там, скорее всего, есть, поэтому
 * до первого успешного цикла или конца своего окна startup_grace прибор молчит. Выяснившийся
 * статус не объявляется переходом, а режим по умолчанию не повод объявлять смену режима.
 */
const blindTrack = (graceFromMs: number): DeviceTrack => ({
  ...freshTrack(graceFromMs),
  modeGuessed: true,
  quiet: true,
});

/**
 * Трек из последнего записанного состояния. Строка в базе переписывается только при смене
 * статуса, причины или режима, поэтому last_ok_at у давно живого прибора старый: online из базы
 * считается подтверждённым на момент переезда, иначе первая же проверка объявила бы прибор
 * протухшим, а следующий цикл вернул бы его в сеть ложным событием. Снимок для событий берётся
 * из того же состояния, дверь и оттайка в нём неизвестны, а переход из неизвестного события
 * не порождает. Подпись публикации совпадает с записанной, поэтому то же состояние заново не уходит.
 */
const restoredTrack = (state: DeviceState, nowMs: number, graceFromMs: number): DeviceTrack => ({
  lastOkAtMs: state.lastOkAt === null ? null : Date.parse(state.lastOkAt),
  handoverAtMs: state.status === 'online' ? nowMs : null,
  graceFromMs,
  consecutiveErrors: state.consecutiveErrors,
  mode: state.mode,
  modeGuessed: true,
  quiet: false,
  doorOpen: null,
  defrostActive: null,
  health: { status: state.status, sinceMs: Date.parse(state.since) },
  status: state.status,
  snapshot: {
    deviceCode: state.deviceCode,
    atMs: nowMs,
    status: state.status,
    mode: state.mode,
    doorOpen: null,
    defrostActive: null,
  },
  published: signatureOf(state),
});

/** Момент последнего успеха для дерева: у переехавшего online не раньше момента переезда. */
const okAtForTree = (track: DeviceTrack): number | null => {
  if (track.handoverAtMs === null) return track.lastOkAtMs;
  return track.lastOkAtMs === null
    ? track.handoverAtMs
    : Math.max(track.lastOkAtMs, track.handoverAtMs);
};

/** Снимок, с которым сравнивается кадр: режим не из кадра не повод объявлять смену режима. */
const frameBaseline = (track: DeviceTrack, mode: DeviceMode): DeviceSnapshot | null =>
  track.snapshot !== null && track.modeGuessed ? { ...track.snapshot, mode } : track.snapshot;

/**
 * Трекер здоровья. Состояние прибора публикуется только при смене статуса, причины или режима,
 * и пока публикация не подтверждена, оно предлагается снова. События двери и оттайки получают
 * время кадра, а переходы статуса время проверки: другого честного момента у них нет.
 * Дерево строится по всему стенду, а состояния и события отдаются только по своим приборам.
 * Окно startup_grace у прибора, принятого без записанного состояния, идёт от момента принятия:
 * иначе у давно работающего экземпляра он сразу получил бы no_data.
 */
export const createHealthTracker = (options: HealthTrackerOptions): HealthTracker => {
  const { stand, clock, policy } = options;
  const startedAtMs = clock.now();
  const known = new Set(stand.devices.map((device) => device.code));
  const owned = new Set<string>();
  const tracks = new Map<string, DeviceTrack>(
    stand.devices.map((device) => [device.code, freshTrack(startedAtMs)]),
  );

  const ownTrack = (deviceCode: string): DeviceTrack | undefined =>
    owned.has(deviceCode) ? tracks.get(deviceCode) : undefined;

  const graceStart = (track: DeviceTrack, nowMs: number): number =>
    nowMs - track.graceFromMs < policy.startupGraceMs ? track.graceFromMs : startedAtMs;

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
                  lastOkAtMs: track === undefined ? null : okAtForTree(track),
                  consecutiveErrors: track?.consecutiveErrors ?? 0,
                  prev: track?.health ?? null,
                };
              }),
          })),
      })),
  });

  const leavesFrom = (graceFromMs: number, nowMs: number): Map<string, HealthNode> =>
    new Map(
      stand.sites
        .flatMap((site) =>
          deviceNodes(
            buildHealthTree({
              site: siteInput(site.code, site.name),
              policy,
              startedAtMs: graceFromMs,
              nowMs,
            }),
          ),
        )
        .map((node) => [node.code, node]),
    );

  return {
    observeCycle: (cycle) => {
      const track = ownTrack(cycle.deviceCode);
      if (track === undefined) return;
      if (cycle.ok) {
        track.lastOkAtMs = Date.parse(cycle.ts);
        track.consecutiveErrors = 0;
      } else {
        track.consecutiveErrors += 1;
      }
    },
    draftFrames: () => {
      const draft = new Map<
        string,
        { readonly track: DeviceTrack; readonly snapshot: DeviceSnapshot }
      >();
      return {
        observe: (observation) => {
          const track = ownTrack(observation.deviceCode);
          if (track === undefined) return [];
          const current: DeviceSnapshot = {
            deviceCode: observation.deviceCode,
            atMs: observation.atMs,
            status: track.status,
            mode: observation.mode,
            doorOpen: observation.doorOpen,
            defrostActive: observation.defrostActive,
          };
          const prev =
            draft.get(observation.deviceCode)?.snapshot ?? frameBaseline(track, observation.mode);
          draft.set(observation.deviceCode, { track, snapshot: current });
          return detectDeviceEvents(prev, current);
        },
        commit: () => {
          for (const [deviceCode, { track, snapshot }] of draft) {
            if (ownTrack(deviceCode) !== track) continue;
            track.mode = snapshot.mode;
            track.modeGuessed = false;
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
      const base = leavesFrom(startedAtMs, nowMs);
      const trees = new Map<number, Map<string, HealthNode>>([[startedAtMs, base]]);

      for (const deviceCode of owned) {
        const track = tracks.get(deviceCode);
        if (track === undefined) continue;
        const from = graceStart(track, nowMs);
        if (!trees.has(from)) trees.set(from, leavesFrom(from, nowMs));
      }

      for (const leaf of base.values()) {
        const track = ownTrack(leaf.code);
        if (track === undefined) continue;
        const node = trees.get(graceStart(track, nowMs))?.get(leaf.code) ?? leaf;

        track.health = { status: node.status, sinceMs: Date.parse(node.since) };
        track.status = node.status;
        if (track.quiet) {
          if (node.reason === 'startup_grace') continue;
          track.quiet = false;
          if (track.snapshot !== null) track.snapshot = { ...track.snapshot, status: node.status };
        }
        events.push(...snapshotEvents(node.code, track, nowMs));

        const state: DeviceState = {
          schema: 'device.state',
          v: 1,
          deviceCode: node.code,
          status: node.status,
          reason: node.reason,
          since: node.since,
          mode: track.mode,
          lastOkAt: track.lastOkAtMs === null ? null : toIsoTimestamp(track.lastOkAtMs),
          consecutiveErrors: node.consecutiveErrors,
        };
        if (signatureOf(state) !== track.published) states.push(state);
      }

      return { states, events };
    },
    confirmPublished: (states) => {
      for (const state of states) {
        const track = ownTrack(state.deviceCode);
        if (track !== undefined) track.published = signatureOf(state);
      }
    },
    owns: (deviceCode) => owned.has(deviceCode),
    release: (deviceCodes) => {
      for (const deviceCode of deviceCodes) {
        if (!known.has(deviceCode)) continue;
        owned.delete(deviceCode);
        tracks.set(deviceCode, freshTrack(startedAtMs));
      }
    },
    adopt: (deviceCodes, restored) => {
      const nowMs = clock.now();
      const byCode = new Map((restored ?? []).map((state) => [state.deviceCode, state]));
      for (const deviceCode of deviceCodes) {
        if (!known.has(deviceCode)) continue;
        const state = byCode.get(deviceCode);
        if (state !== undefined) {
          tracks.set(deviceCode, restoredTrack(state, nowMs, startedAtMs));
        } else if (restored === null) {
          tracks.set(deviceCode, blindTrack(nowMs));
        } else {
          tracks.set(deviceCode, freshTrack(nowMs));
        }
        owned.add(deviceCode);
      }
    },
  };
};
