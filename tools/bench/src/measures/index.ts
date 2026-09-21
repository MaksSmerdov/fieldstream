import { compression } from './compression.js';
import { images } from './images.js';
import { lag } from './lag.js';
import { latency } from './latency.js';
import { memory } from './memory.js';
import { query } from './query.js';
import { throughput } from './throughput.js';
import { volumes } from './volumes.js';
import type { Measure, MeasureName } from '../measure.js';

/**
 * Реестр замеров: имя команды и замер за ним. Запись обязательна для каждого имени из
 * MEASURE_NAMES, а имя внутри замера обязано совпадать с ключом реестра.
 */
export const MEASURES: Readonly<Record<MeasureName, Measure>> = Object.freeze({
  throughput,
  latency,
  lag,
  memory,
  images,
  volumes,
  compression,
  query,
});
