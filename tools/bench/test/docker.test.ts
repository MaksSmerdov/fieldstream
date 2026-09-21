import { describe, expect, it } from 'vitest';
import {
  containersArgs,
  failureText,
  howOf,
  imagesArgs,
  labelsOf,
  outLines,
  parseImages,
  parseServices,
  quoteArg,
  parseStats,
  parseVolumes,
  shareOf,
  standVolumes,
  statsArgs,
  usageOf,
  volumesArgs,
} from '../src/docker.js';

/** Вывод docker ps со стенда: имя контейнера и служба compose за ним. */
const SERVICES = [
  'fieldstream-web-1|web',
  'fieldstream-edge-collector-1|edge-collector',
  'fieldstream-api-gateway-1|api-gateway',
  'fieldstream-stream-processor-1|stream-processor',
  'fieldstream-kafka-1|kafka',
  'fieldstream-device-sim-1|device-sim',
  'fieldstream-timescaledb-1|timescaledb',
].join('\n');

/** Вывод docker stats --no-stream со стенда. */
const STATS = [
  'fieldstream-api-gateway-1|4.43%|89.16MiB / 11.68GiB|0.75%|11',
  'fieldstream-kafka-1|0.62%|727.9MiB / 1GiB|71.09%|109',
  'fieldstream-timescaledb-1|3.45%|187.6MiB / 11.68GiB|1.57%|12',
].join('\n');

/** Вывод docker image ls fieldstream/* со стенда. */
const IMAGES = [
  'fieldstream/edge-collector|dev|294MB',
  'fieldstream/api-gateway|dev|315MB',
  'fieldstream/stream-processor|dev|312MB',
  'fieldstream/device-sim|dev|263MB',
  'fieldstream/migrator|dev|264MB',
  'fieldstream/seed|dev|264MB',
  'fieldstream/web|dev|75MB',
].join('\n');

/** Вывод docker system df -v со стенда: безымянные тома хоста и два тома проекта. */
const VOLUMES = [
  '416247a53baa3a0db3f79c6fce565550ccc9363166cf5f69a0221264aa66a600|0B|1|com.docker.volume.anonymous=',
  'd01faffb09619449ac4b5de771990a53c0a7e0ccab83a99f2e6b71f878e83960|0B|0|com.docker.volume.anonymous=',
  'fieldstream_kafka-data|1.941GB|1|com.docker.compose.config-hash=dd764e66e453f9cb27f6c221bea1854950071b3ae420ab2ec3759aa9c715575e,com.docker.compose.project=fieldstream,com.docker.compose.version=5.5.1,com.docker.compose.volume=kafka-data',
  'fieldstream_tsdb-data|1.001GB|1|com.docker.compose.config-hash=19256b9d973b2adc1b420576e3ee9816115ef2855867760a3e1bff163d27e410,com.docker.compose.project=fieldstream,com.docker.compose.version=5.5.1,com.docker.compose.volume=tsdb-data',
].join('\n');

describe('строки и поля вывода docker', () => {
  it('пустые строки и отступы в разбор не идут', () => {
    expect(outLines('\n a|b \n\n c|d\n')).toEqual(['a|b', 'c|d']);
    expect(outLines('')).toEqual([]);
  });

  it('доля из процента, прочерк и мусор это null', () => {
    expect(shareOf('71.09%')).toBeCloseTo(0.7109, 6);
    expect(shareOf('0.00%')).toBe(0);
    expect(shareOf('--')).toBeNull();
    expect(shareOf('')).toBeNull();
  });

  it('занятое и предел памяти читаются из одной ячейки', () => {
    expect(usageOf('727.9MiB / 1GiB')).toEqual({ used: 727.9 * 1_048_576, limit: 1_073_741_824 });
    expect(usageOf('пусто')).toEqual({ used: null, limit: null });
  });

  it('метки docker печатает одной строкой через запятую', () => {
    expect(labelsOf('com.docker.compose.project=fieldstream,com.docker.volume.anonymous=')).toEqual(
      { 'com.docker.compose.project': 'fieldstream', 'com.docker.volume.anonymous': '' },
    );
    expect(labelsOf('')).toEqual({});
  });
});

describe('разбор вывода docker ps', () => {
  it('даёт контейнеры стенда с именами служб compose', () => {
    const services = parseServices(SERVICES);

    expect(services).toHaveLength(7);
    expect(services[4]).toEqual({ name: 'fieldstream-kafka-1', service: 'kafka' });
  });

  it('контейнер без метки службы зовётся своим именем, битая строка пропускается', () => {
    expect(parseServices('lonely-container|\nбез разделителя\n')).toEqual([
      { name: 'lonely-container', service: 'lonely-container' },
    ]);
  });
});

describe('разбор вывода docker stats', () => {
  it('даёт память, предел и доли процессора по контейнерам', () => {
    const stats = parseStats(STATS);

    expect(stats).toHaveLength(3);
    expect(stats[1]).toEqual({
      name: 'fieldstream-kafka-1',
      cpuShare: 0.62 / 100,
      memBytes: 727.9 * 1_048_576,
      limitBytes: 1_073_741_824,
      memShare: 71.09 / 100,
      pids: 109,
    });
  });

  it('непрочитанные поля становятся null, а не выдуманным числом', () => {
    expect(parseStats('fieldstream-seed-1|--|-- / --|--|0')).toEqual([
      {
        name: 'fieldstream-seed-1',
        cpuShare: null,
        memBytes: null,
        limitBytes: null,
        memShare: null,
        pids: 0,
      },
    ]);
  });
});

describe('разбор вывода docker image ls', () => {
  it('даёт имя с меткой и размер в байтах по десятичным единицам docker', () => {
    const found = parseImages(IMAGES);

    expect(found).toHaveLength(7);
    expect(found[1]).toEqual({ reference: 'fieldstream/api-gateway:dev', bytes: 315_000_000 });
    expect(found[6]).toEqual({ reference: 'fieldstream/web:dev', bytes: 75_000_000 });
  });

  it('образ без размера не теряется, но размер у него null', () => {
    expect(parseImages('fieldstream/web|dev|<unknown>')).toEqual([
      { reference: 'fieldstream/web:dev', bytes: null },
    ]);
  });
});

describe('разбор вывода docker system df -v', () => {
  it('даёт тома с размером, держателями и метками проекта', () => {
    const found = parseVolumes(VOLUMES);

    expect(found).toHaveLength(4);
    expect(found[2]).toEqual({
      name: 'fieldstream_kafka-data',
      volume: 'kafka-data',
      project: 'fieldstream',
      bytes: 1.941 * 1_000_000_000,
      links: 1,
    });
    expect(found[0]?.project).toBeNull();
  });

  it('тома стенда отбираются по метке проекта, безымянные тома хоста в замер не идут', () => {
    expect(
      standVolumes(parseVolumes(VOLUMES), 'fieldstream').map((volume) => volume.volume),
    ).toEqual(['kafka-data', 'tsdb-data']);
    expect(standVolumes(parseVolumes(VOLUMES), 'другой-проект')).toEqual([]);
  });
});

describe('команды docker', () => {
  it('контейнеры и снимок отбираются по метке проекта и именам', () => {
    expect(containersArgs('fieldstream')).toEqual([
      'ps',
      '--filter',
      'label=com.docker.compose.project=fieldstream',
      '--format',
      '{{.Names}}|{{.Label "com.docker.compose.service"}}',
    ]);
    expect(statsArgs(['fieldstream-kafka-1'])).toEqual([
      'stats',
      '--no-stream',
      '--format',
      '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}',
      'fieldstream-kafka-1',
    ]);
    expect(imagesArgs('fieldstream/*')).toEqual([
      'image',
      'ls',
      'fieldstream/*',
      '--format',
      '{{.Repository}}|{{.Tag}}|{{.Size}}',
    ]);
  });

  it('размер одного тома берётся тем же system df с отбором по имени', () => {
    expect(volumesArgs('fieldstream_kafka-data')[4]).toBe(
      '{{range .Volumes}}{{if eq .Name "fieldstream_kafka-data"}}' +
        '{{.Name}}|{{.Size}}|{{.Links}}|{{.Labels}}{{println}}{{end}}{{end}}',
    );
    expect(volumesArgs().slice(0, 3)).toEqual(['system', 'df', '-v']);
  });

  it('аргумент команды закрывается одинарными кавычками', () => {
    expect(quoteArg('SELECT 1')).toBe("'SELECT 1'");
    expect(quoteArg("SELECT 'a'")).toBe("'SELECT '\\''a'\\'''");
  });

  it('команда для ручного повтора берёт шаблоны и метки в кавычки', () => {
    expect(howOf(statsArgs(['fieldstream-kafka-1']))).toBe(
      "docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' fieldstream-kafka-1",
    );
    expect(howOf(containersArgs('fieldstream'))).toContain(
      '--filter label=com.docker.compose.project=fieldstream',
    );
  });
});

describe('отказ запуска', () => {
  it('объясняется командой, кодом возврата и жалобой docker', () => {
    const why = failureText(['stats', '--no-stream', 'нет-такого'], {
      code: 1,
      stdout: '',
      stderr: 'Error response from daemon: No such container: нет-такого\n',
    });

    expect(why).toContain('docker stats --no-stream');
    expect(why).toContain('ответил кодом 1');
    expect(why).toContain('No such container');
  });

  it('несостоявшийся запуск говорит, что docker не найден', () => {
    const why = failureText(['version'], {
      code: -1,
      stdout: '',
      stderr: '\ndocker не найден в PATH',
    });

    expect(why).toBe('docker version не запустился: docker не найден в PATH.');
  });

  it('молчащий демон объясняется отдельной подсказкой', () => {
    const why = failureText(['system', 'df'], {
      code: 1,
      stdout: '',
      stderr: 'error during connect: Get "http://docker/v1.51/info": open //./pipe/docker: нет',
    });

    expect(why).toContain('Демон docker не отвечает');
  });
});
