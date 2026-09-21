import { containersArgs, parseServices, parseStats, statsArgs } from '../docker.js';
import type { ContainerStat, ServiceContainer } from '../docker.js';
import type { Docker, Measure, Row } from '../measure.js';
import { formatBytes, formatNumber, formatPercent } from '../stats.js';

/** Доля предела, с которой контейнеру уже тесно: такое наблюдение пишется в протокол. */
const TIGHT_SHARE = 0.8;

/** Контейнер стенда и его снимок. */
interface Pair {
  readonly container: ServiceContainer;
  readonly stat: ContainerStat;
}

/** Запущенные контейнеры проекта по порядку служб: чужие контейнеры хоста в замер не идут. */
const containersOf = async (docker: Docker): Promise<ServiceContainer[]> => {
  const text = await docker.out(containersArgs(docker.project));

  return parseServices(text).sort((left, right) => left.service.localeCompare(right.service));
};

/** Строка о контейнере: занятая память, её предел и доля процессора в момент снимка. */
const rowOf = (docker: Docker, pair: Pair): Row => {
  const { stat } = pair;
  const used = stat.memBytes === null ? 'память не прочитана' : formatBytes(stat.memBytes);
  const limit = stat.limitBytes === null ? '' : ` из ${formatBytes(stat.limitBytes)}`;
  const share = stat.memShare === null ? '' : ` (${formatPercent(stat.memShare)})`;
  const cpu = stat.cpuShare === null ? '' : `, процессор ${formatPercent(stat.cpuShare)}`;
  const pids = stat.pids === null ? '' : `, процессов ${formatNumber(stat.pids)}`;

  return {
    label: `контейнер ${pair.container.service}`,
    value: `${used}${limit}${share}${cpu}${pids}`,
    how: docker.how(statsArgs([pair.container.name])),
  };
};

/** Память контейнеров стенда: один снимок docker stats по контейнерам проекта. */
export const memory: Measure = {
  name: 'memory',
  title: 'память и процессор контейнеров стенда',
  needs: ['docker'],
  run: async (bench) => {
    const { docker } = bench;
    const containers = await containersOf(docker);
    if (containers.length === 0) {
      throw new Error(
        `запущенных контейнеров проекта ${docker.project} нет: стенд поднят командой pnpm stack:up?`,
      );
    }

    const names = containers.map((container) => container.name);
    const stats = parseStats(await docker.out(statsArgs(names)));
    const byName = new Map(stats.map((stat) => [stat.name, stat]));
    const pairs = containers.flatMap((container) => {
      const stat = byName.get(container.name);
      return stat === undefined ? [] : [{ container, stat }];
    });

    for (const pair of pairs) {
      const share = pair.stat.memShare;
      if (share !== null && share >= TIGHT_SHARE) {
        bench.observe(
          `контейнер ${pair.container.service} занял ${formatPercent(share)} своего предела памяти`,
        );
      }
    }

    const total = pairs.reduce((sum, pair) => sum + (pair.stat.memBytes ?? 0), 0);
    const rows = pairs.map((pair) => rowOf(docker, pair));

    return {
      rows: [
        ...rows,
        {
          label: 'итого по стенду',
          value: `${formatBytes(total)} в ${formatNumber(pairs.length)} контейнерах`,
          how: docker.how(statsArgs(names)),
        },
      ],
      note:
        'Мгновенный снимок docker stats без усреднения: доля процессора считается за короткий ' +
        'промежуток перед снимком. Предел памяти задан в compose только брокеру (mem_limit: 1g), ' +
        'остальные контейнеры видят память хоста, поэтому их доля предела мало о чём говорит.',
    };
  },
};
