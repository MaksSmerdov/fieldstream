import { EXPERIMENT_NAMES, isExperimentName } from './experiment.js';
import { EXPERIMENTS } from './experiments/index.js';
import { errorText, runExperiment } from './lab.js';

const NAME_WIDTH = 13;

/** Список опытов: печатается без аргументов и при неизвестном имени. */
const usage = (): string =>
  [
    'Лаборатория Kafka: pnpm --filter @fieldstream/kafka-lab run lab <опыт>',
    '',
    'Опыты:',
    ...EXPERIMENT_NAMES.map((name) => `  ${name.padEnd(NAME_WIDTH)}${EXPERIMENTS[name].title}`),
    '',
    'Брокер берётся из KAFKA_BROKERS, по умолчанию localhost:29092.',
    'Учебные топики и группы называются fieldstream.lab.<опыт>.* и убираются после прогона.',
  ].join('\n');

const [name, ...rest] = process.argv.slice(2);

if (name === undefined || name === '-h' || name === '--help') {
  process.stdout.write(`${usage()}\n`);
} else if (!isExperimentName(name)) {
  process.stderr.write(`kafka-lab: опыт ${name} неизвестен\n\n${usage()}\n`);
  process.exitCode = 1;
} else {
  try {
    await runExperiment(EXPERIMENTS[name], rest);
  } catch (error) {
    process.stderr.write(`kafka-lab: опыт ${name} не доведён до конца: ${errorText(error)}\n`);
    process.exitCode = 1;
  }
}
