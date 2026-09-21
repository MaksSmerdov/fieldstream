import { imagesArgs, parseImages } from '../docker.js';
import type { Measure, Row } from '../measure.js';
import { formatBytes, formatNumber } from '../stats.js';

/** Размеры образов стенда: docker image ls по именам fieldstream/* и сумма по ним. */
export const images: Measure = {
  name: 'images',
  title: 'размеры образов стенда',
  needs: ['docker'],
  run: async (bench) => {
    const { docker } = bench;
    const args = imagesArgs(`${docker.project}/*`);
    const found = parseImages(await docker.out(args)).sort((left, right) =>
      left.reference.localeCompare(right.reference),
    );
    if (found.length === 0) {
      throw new Error(`образов ${docker.project}/* нет: стенд собран командой pnpm stack:up?`);
    }

    const rows: Row[] = found.map((image) => ({
      label: `образ ${image.reference}`,
      value: image.bytes === null ? 'размер не прочитан' : formatBytes(image.bytes),
      how: docker.how(imagesArgs(image.reference)),
    }));
    const total = found.reduce((sum, image) => sum + (image.bytes ?? 0), 0);

    return {
      rows: [
        ...rows,
        {
          label: `итого по ${formatNumber(found.length)} образам`,
          value: formatBytes(total),
          how: docker.how(args),
          note:
            'сумма номинальных размеров: общие слои базового образа посчитаны в каждом образе, ' +
            'на диске все образы вместе занимают меньше',
        },
      ],
      note:
        'Размеры docker печатает десятичными единицами (315MB), в таблице они пересчитаны ' +
        'в двоичные (МиБ). Считаются только собранные образы стенда, сторонние образы ' +
        '(база, брокер) в замер не идут.',
    };
  },
};
