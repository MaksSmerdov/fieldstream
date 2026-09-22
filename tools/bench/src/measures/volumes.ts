import { parseVolumes, standVolumes, volumesArgs } from '../docker.js';
import type { VolumeSize } from '../docker.js';
import type { Docker, Measure, Row } from '../measure.js';
import { formatBytes, formatNumber } from '../stats.js';

/** Что лежит в томах стенда: по коротким именам compose назначение тома не видно. */
const CONTENT: Readonly<Record<string, string>> = {
  'kafka-data': 'журналы боевых топиков',
  'tsdb-data': 'данные базы',
};

/** Строка о томе: имя тома в compose, назначение и размер по счёту docker. */
const rowOf = (docker: Docker, volume: VolumeSize): Row => {
  const short = volume.volume ?? volume.name;
  const content = CONTENT[short];
  const size = volume.bytes === null ? 'размер не прочитан' : formatBytes(volume.bytes);
  const links = volume.links === null ? '' : `, держат контейнеров ${formatNumber(volume.links)}`;

  return {
    label: content === undefined ? `том ${short}` : `том ${short}, ${content}`,
    value: `${size}${links}`,
    how: docker.how(volumesArgs(volume.name)),
  };
};

/** Размеры томов стенда: docker system df -v по томам с меткой проекта. */
export const volumes: Measure = {
  name: 'volumes',
  title: 'размеры томов стенда',
  needs: ['docker'],
  run: async (bench) => {
    const { docker } = bench;
    const args = volumesArgs();
    const found = standVolumes(parseVolumes(await docker.out(args)), docker.project).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    if (found.length === 0) {
      throw new Error(`томов проекта ${docker.project} нет: стенд поднят командой pnpm stack:up?`);
    }

    const total = found.reduce((sum, volume) => sum + (volume.bytes ?? 0), 0);

    return {
      rows: [
        ...found.map((volume) => rowOf(docker, volume)),
        {
          label: 'итого по томам стенда',
          value: formatBytes(total),
          how: docker.how(args),
        },
      ],
      note:
        'Размеры docker печатает десятичными единицами (1.941GB), в таблице они пересчитаны ' +
        'в двоичные (ГиБ). В счёт идут только тома с меткой проекта compose, безымянные тома ' +
        'хоста в замер не попадают. Том базы растёт вместе с ts.readings, том брокера это ' +
        'журналы топиков со сроком хранения, заданным брокером.',
    };
  },
};
