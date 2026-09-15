import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { TOPICS } from '@fieldstream/contracts';
import type { PipelineResponse, PipelineTopic } from '@fieldstream/contracts';
import { counted } from '../../../../shared/text/plural.js';
import { MAP_NODES, MAP_VIEWBOX, edgeShape, lagTrend } from '../../pipeline-geometry.js';
import type { LagHistory, MapNodeId } from '../../pipeline-geometry.js';
import { numberText, rateSpoken, rateText } from '../../pipeline-words.js';
import styles from './PipelineMap.module.scss';

interface Props {
  readonly data: PipelineResponse;
  readonly history: LagHistory;
}

interface MapNode {
  readonly id: MapNodeId;
  readonly title: string;
  readonly lines: readonly string[];
  readonly warn: boolean;
}

interface MapEdge {
  readonly from: MapNodeId;
  readonly to: MapNodeId;
  readonly rate?: number | null;
}

const PROCESSOR_GROUP = 'fs-processor';
const GATEWAY_GROUP_PREFIX = 'fs-api-';

const TITLE_Y = 24;
const LINE_STEP = 18;

/** Число партиций топика словами. */
const partitionsText = (topic: PipelineTopic | undefined): string =>
  topic === undefined
    ? 'нет в снимке'
    : counted(topic.partitions.length, ['партиция', 'партиции', 'партиций']);

/** Узлы, связи и описание схемы по снимку и истории отставания. */
const modelOf = (
  data: PipelineResponse,
  history: LagHistory,
): { nodes: MapNode[]; edges: MapEdge[]; summary: string } => {
  const topics = new Map(data.topics.map((topic) => [topic.name, topic]));
  const raw = topics.get(TOPICS.telemetryRaw.name);
  const cycles = topics.get(TOPICS.pollCycles.name);
  const status = topics.get(TOPICS.lineStatus.name);
  const processor = data.groups.find((group) => group.groupId === PROCESSOR_GROUP);
  const brokerDown = data.brokerError !== null;

  const growing = (groupId: string): boolean =>
    !brokerDown && lagTrend(history.series.get(groupId) ?? []) === 'growing';
  const processorGrowing = growing(PROCESSOR_GROUP);
  const gatewayGrowing = data.groups.some(
    (group) => group.groupId.startsWith(GATEWAY_GROUP_PREFIX) && growing(group.groupId),
  );

  const processorLines =
    processor === undefined
      ? ['группы нет']
      : [
          `отставание ${numberText(processor.totalLag)}`,
          `экземпляров ${String(processor.members.length)}`,
        ];

  const nodes: MapNode[] = [
    { id: 'sim', title: 'Симулятор', lines: ['приборы Modbus'], warn: false },
    { id: 'collector', title: 'Сборщик', lines: ['опрос линий'], warn: false },
    { id: 'raw', title: 'Сырые кадры', lines: [partitionsText(raw)], warn: brokerDown },
    { id: 'cycles', title: 'Циклы опроса', lines: [partitionsText(cycles)], warn: brokerDown },
    { id: 'status', title: 'Статус линий', lines: [partitionsText(status)], warn: brokerDown },
    {
      id: 'processor',
      title: 'Процессор',
      lines: processorLines,
      warn: brokerDown || processorGrowing,
    },
    {
      id: 'db',
      title: 'База',
      lines: [`недоставленных ${numberText(data.dlq.unresolved)}`],
      warn: false,
    },
    {
      id: 'gateway',
      title: 'Шлюз',
      lines: ['API и живой канал'],
      warn: brokerDown || gatewayGrowing,
    },
    {
      id: 'browser',
      title: 'Браузер',
      lines: [
        `соединений ${numberText(data.live.streams)}`,
        `событий ${rateText(data.live.eventsPerSec)}`,
      ],
      warn: false,
    },
  ];

  const edges: MapEdge[] = [
    { from: 'sim', to: 'collector' },
    { from: 'collector', to: 'raw', rate: raw?.messagesPerSec ?? null },
    { from: 'collector', to: 'cycles', rate: cycles?.messagesPerSec ?? null },
    { from: 'collector', to: 'status', rate: status?.messagesPerSec ?? null },
    { from: 'raw', to: 'processor' },
    { from: 'cycles', to: 'processor' },
    { from: 'processor', to: 'db' },
    { from: 'status', to: 'gateway' },
    { from: 'db', to: 'gateway' },
    { from: 'gateway', to: 'browser' },
  ];

  const warnings = [
    brokerDown ? 'брокер не отвечает' : null,
    processorGrowing ? 'отставание процессора растёт' : null,
    gatewayGrowing ? 'отставание шлюза растёт' : null,
  ].filter((item): item is string => item !== null);

  const summary = [
    'Схема конвейера',
    `сборщик пишет сырые кадры: ${rateSpoken(raw?.messagesPerSec ?? null)}, циклы опроса: ${rateSpoken(cycles?.messagesPerSec ?? null)}, статус линий: ${rateSpoken(status?.messagesPerSec ?? null)}`,
    `процессор: ${processorLines.join(', ')}`,
    `база: недоставленных ${numberText(data.dlq.unresolved)}`,
    `браузер: соединений ${numberText(data.live.streams)}, событий ${rateSpoken(data.live.eventsPerSec)}`,
    warnings.length === 0 ? null : `внимание: ${warnings.join(', ')}`,
  ]
    .filter((item): item is string => item !== null)
    .join('. ');

  return { nodes, edges, summary: `${summary}.` };
};

/** Схема конвейера от симулятора до браузера с темпом топиков и отставанием процессора. */
export const PipelineMap = ({ data, history }: Props): React.JSX.Element => {
  const { nodes, edges, summary } = modelOf(data, history);

  return (
    <Paper variant="outlined" className={styles['map']}>
      <Typography variant="subtitle1" component="h2" className={styles['map__heading']}>
        Схема конвейера
      </Typography>

      <div
        className={styles['map__scroll']}
        role="region"
        aria-label="Схема конвейера"
        tabIndex={0}
      >
        <svg
          className={styles['map__svg']}
          viewBox={`0 0 ${String(MAP_VIEWBOX.width)} ${String(MAP_VIEWBOX.height)}`}
          role="img"
          aria-label={summary}
        >
          {edges.map((edge) => {
            const shape = edgeShape(MAP_NODES[edge.from], MAP_NODES[edge.to]);

            return (
              <g key={`${edge.from}-${edge.to}`}>
                <path d={shape.path} className={styles['map__edge']} />
                <polygon points={shape.arrow} className={styles['map__arrow']} />
                {edge.rate === undefined ? null : (
                  <text
                    x={shape.labelX}
                    y={shape.labelY}
                    textAnchor="middle"
                    className={styles['map__rate']}
                  >
                    {rateText(edge.rate)}
                  </text>
                )}
              </g>
            );
          })}

          {nodes.map((node) => {
            const box = MAP_NODES[node.id];

            return (
              <g key={node.id} data-node={node.id} data-warn={node.warn ? 'true' : 'false'}>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  rx={10}
                  className={
                    node.warn
                      ? `${styles['map__node']} ${styles['map__node_warn']}`
                      : styles['map__node']
                  }
                />
                <text
                  x={box.x + box.width / 2}
                  y={box.y + TITLE_Y}
                  textAnchor="middle"
                  className={styles['map__title']}
                >
                  {node.title}
                </text>
                {node.lines.map((line, index) => (
                  <text
                    key={line}
                    x={box.x + box.width / 2}
                    y={box.y + TITLE_Y + LINE_STEP * (index + 1)}
                    textAnchor="middle"
                    className={styles['map__line']}
                  >
                    {line}
                  </text>
                ))}
                {node.warn ? (
                  <g>
                    <circle
                      cx={box.x + box.width - 12}
                      cy={box.y + 12}
                      r={8}
                      className={styles['map__badge']}
                    />
                    <text
                      x={box.x + box.width - 12}
                      y={box.y + 16}
                      textAnchor="middle"
                      className={styles['map__mark']}
                    >
                      !
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </Paper>
  );
};
