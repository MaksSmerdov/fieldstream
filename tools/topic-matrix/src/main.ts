import { writeFile } from 'node:fs/promises';
import { TOPICS } from '@fieldstream/contracts';
import { TOPICS_CONF_PATH, renderTopicsConf } from './render.js';

const topics = Object.values(TOPICS);

await writeFile(TOPICS_CONF_PATH, renderTopicsConf(topics), 'utf8');
process.stdout.write(`${TOPICS_CONF_PATH}: ${String(topics.length)} топиков\n`);
