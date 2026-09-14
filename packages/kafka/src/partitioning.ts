import { AssignerProtocol, Partitioners } from 'kafkajs';
import type { Assignment, PartitionAssigner, PartitionMetadata } from 'kafkajs';

export const CO_PARTITION_ASSIGNER = 'CoPartitionAssigner';

/**
 * Назначатель ко-партиционирования. Участники сортируются по memberId, и партиция с номером p
 * любого топика подписки достаётся участнику с номером p по кругу. Партиции с одним номером
 * в разных топиках поэтому всегда у одного участника, при любом их числе. Условие одно:
 * у топиков, которые читаются вместе, одинаковое число партиций и один ключ.
 */
export const createCoPartitionAssigner: PartitionAssigner = ({ cluster }) => ({
  name: CO_PARTITION_ASSIGNER,
  version: 0,
  assign: ({ members, topics }) => {
    const sorted = members.map((member) => member.memberId).sort();
    const assignments = new Map<string, Assignment>(sorted.map((memberId) => [memberId, {}]));

    for (const topic of topics) {
      const partitions = cluster
        .findTopicPartitionMetadata(topic)
        .map((metadata) => metadata.partitionId)
        .sort((left, right) => left - right);

      for (const partition of partitions) {
        const memberId = sorted[partition % sorted.length];
        const assignment = memberId === undefined ? undefined : assignments.get(memberId);
        if (assignment === undefined) continue;
        (assignment[topic] ??= []).push(partition);
      }
    }

    return Promise.resolve(
      [...assignments].map(([memberId, assignment]) => ({
        memberId,
        memberAssignment: AssignerProtocol.MemberAssignment.encode({
          version: 0,
          assignment,
          userData: Buffer.alloc(0),
        }),
      })),
    );
  },
  protocol: ({ topics }) => ({
    name: CO_PARTITION_ASSIGNER,
    metadata: AssignerProtocol.MemberMetadata.encode({
      version: 0,
      topics,
      userData: Buffer.alloc(0),
    }),
  }),
});

const partitioner = Partitioners.DefaultPartitioner();

/** Метаданные топика нужной длины: разделителю по ключу важно только число партиций. */
const metadataOf = (partitions: number): PartitionMetadata[] =>
  Array.from({ length: partitions }, (_, partitionId) => ({
    partitionErrorCode: 0,
    partitionId,
    leader: 0,
    replicas: [0],
    isr: [0],
  }));

/**
 * Партиция, в которую продюсер проекта положит сообщение с этим ключом. Считает сам
 * разделитель kafkajs, а не копия его хеша, поэтому разойтись с продюсером ответ не может.
 */
export const partitionForKey = (key: string, partitions: number): number =>
  partitioner({
    topic: 'partition-for-key',
    partitionMetadata: metadataOf(partitions),
    message: { key, value: null },
  });
