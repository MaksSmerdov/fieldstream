import { describe, expect, it } from 'vitest';
import { AssignerProtocol, Partitioners } from 'kafkajs';
import type { Cluster, GroupMember, PartitionMetadata } from 'kafkajs';
import {
  CO_PARTITION_ASSIGNER,
  createCoPartitionAssigner,
  partitionForKey,
} from '../src/partitioning.js';

const RAW = 'fieldstream.telemetry.raw.v1';
const CYCLES = 'fieldstream.collector.cycles.v2';
const PARTITIONS = 6;

/** Коды приборов стенда: пакет шины от профилей не зависит, поэтому список здесь явный. */
const STAND_CODES = [
  'RC-101',
  'RC-102',
  'RC-103',
  'PM-201',
  'PM-202',
  'PM-203',
  'RC-104',
  'RC-105',
  'RC-106',
  'PM-204',
  'PM-205',
  'PM-206',
  'RC-107',
  'RC-108',
  'RC-109',
  'PM-207',
  'PM-208',
  'PM-209',
  'RC-110',
  'RC-111',
  'RC-112',
  'PM-210',
  'PM-211',
  'PM-212',
];

/** Метаданные партиций вперемешку и с одной партицией без лидера, как бывает у живого брокера. */
const liveMetadata = (partitions: number): PartitionMetadata[] =>
  Array.from({ length: partitions }, (_, index) => {
    const partitionId = partitions - 1 - index;
    return {
      partitionErrorCode: 0,
      partitionId,
      leader: partitionId === 1 ? -1 : 1,
      replicas: [1],
      isr: partitionId === 1 ? [] : [1],
    };
  });

const cluster = {
  findTopicPartitionMetadata: () => liveMetadata(PARTITIONS),
} as unknown as Cluster;

/** Участники с идентификаторами не по порядку: назначатель обязан сортировать сам. */
const membersOf = (count: number): GroupMember[] =>
  Array.from({ length: count }, (_, index) => ({
    memberId: `stream-processor-${String((index * 7) % 11)}-${String(index)}`,
    memberMetadata: Buffer.alloc(0),
  }));

/** Раскладка по участникам в разобранном виде. */
const assign = async (count: number): Promise<Map<string, Record<string, number[]>>> => {
  const assigner = createCoPartitionAssigner({
    cluster,
    groupId: 'fs-processor',
    logger: undefined as never,
  });
  const result = await assigner.assign({ members: membersOf(count), topics: [RAW, CYCLES] });

  return new Map(
    result.map((item) => [
      item.memberId,
      AssignerProtocol.MemberAssignment.decode(item.memberAssignment)?.assignment ?? {},
    ]),
  );
};

describe('назначатель ко-партиционирования', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'у %i участников партиции с одним номером в обоих топиках у одного участника',
    async (count) => {
      const assignments = await assign(count);

      expect(assignments.size).toBe(count);
      for (const assignment of assignments.values()) {
        expect(assignment[RAW] ?? []).toEqual(assignment[CYCLES] ?? []);
      }
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'у %i участников ни одна партиция не потеряна и не отдана двоим',
    async (count) => {
      const assignments = [...(await assign(count)).values()];

      for (const topic of [RAW, CYCLES]) {
        const taken = assignments.flatMap((assignment) => assignment[topic] ?? []);
        expect([...taken].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5]);
      }
      expect(assignments.every((assignment) => (assignment[RAW] ?? []).length > 0)).toBe(true);
    },
  );

  it('номер партиции решает участника по кругу среди отсортированных идентификаторов', async () => {
    const assignments = await assign(4);
    const sorted = [...assignments.keys()].sort();

    expect(sorted.map((memberId) => assignments.get(memberId)?.[RAW])).toEqual([
      [0, 4],
      [1, 5],
      [2],
      [3],
    ]);
  });

  it('объявляет протокол под своим именем со списком топиков', () => {
    const assigner = createCoPartitionAssigner({
      cluster,
      groupId: 'fs-processor',
      logger: undefined as never,
    });
    const protocol = assigner.protocol({ topics: [RAW, CYCLES] });

    expect(assigner.name).toBe(CO_PARTITION_ASSIGNER);
    expect(protocol.name).toBe(CO_PARTITION_ASSIGNER);
    expect(AssignerProtocol.MemberMetadata.decode(protocol.metadata)?.topics).toEqual([
      RAW,
      CYCLES,
    ]);
  });
});

describe('партиция по ключу', () => {
  it('совпадает с выбором разделителя продюсера для всех приборов стенда', () => {
    const producerPartitioner = Partitioners.DefaultPartitioner();

    for (const code of STAND_CODES) {
      expect(partitionForKey(code, PARTITIONS)).toBe(
        producerPartitioner({
          topic: RAW,
          partitionMetadata: liveMetadata(PARTITIONS),
          message: { key: code, value: 'кадр' },
        }),
      );
    }
  });

  it('стабильна от вызова к вызову и не выходит за число партиций', () => {
    const first = STAND_CODES.map((code) => partitionForKey(code, PARTITIONS));
    const second = STAND_CODES.map((code) => partitionForKey(code, PARTITIONS));

    expect(second).toEqual(first);
    expect(first.every((partition) => partition >= 0 && partition < PARTITIONS)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
});
