import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TOPICS } from '@fieldstream/contracts';
import { TOPICS_CONF_PATH, renderTopicsConf } from './render.js';

const topics = Object.values(TOPICS);

describe('конфиг создания топиков', () => {
  it('infra/kafka/topics.conf совпадает с манифестом (перегенерировать: pnpm topics:gen)', async () => {
    expect(await readFile(TOPICS_CONF_PATH, 'utf8')).toBe(renderTopicsConf(topics));
  });

  it('у каждого топика есть политика очистки, у удаляемых ещё и срок хранения', () => {
    const lines = renderTopicsConf(topics)
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(lines).toHaveLength(topics.length);
    for (const line of lines) {
      const [, partitions, configs = ''] = line.split(' ');
      expect(Number(partitions)).toBeGreaterThan(0);
      expect(configs).toMatch(/cleanup\.policy=(delete|compact)/);
      if (configs.includes('cleanup.policy=delete')) expect(configs).toMatch(/retention\.ms=\d+/);
    }
  });

  it('дополнительные настройки манифеста попадают в строку топика', () => {
    const conf = renderTopicsConf([
      {
        name: 'fieldstream.demo.v1',
        partitions: 2,
        cleanupPolicy: 'compact',
        retentionMs: null,
        configs: { 'segment.ms': '60000' },
      },
    ]);

    expect(conf).toContain('fieldstream.demo.v1 2 cleanup.policy=compact,segment.ms=60000\n');
  });
});
