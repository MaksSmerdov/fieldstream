#!/usr/bin/env bash
set -euo pipefail

bootstrap="${KAFKA_BOOTSTRAP:-kafka:9092}"
topics_file="${TOPICS_FILE:-/opt/fieldstream/topics.conf}"
kafka_topics=/opt/kafka/bin/kafka-topics.sh
kafka_configs=/opt/kafka/bin/kafka-configs.sh

while read -r name partitions configs; do
  if [[ -z "${name}" || "${name}" == \#* ]]; then
    continue
  fi

  args=(--bootstrap-server "${bootstrap}" --create --if-not-exists
    --topic "${name}" --partitions "${partitions}" --replication-factor 1)

  if [[ -n "${configs:-}" ]]; then
    IFS=',' read -ra pairs <<< "${configs}"
    for pair in "${pairs[@]}"; do
      args+=(--config "${pair}")
    done
  fi

  "${kafka_topics}" "${args[@]}"

  if [[ -n "${configs:-}" ]]; then
    "${kafka_configs}" --bootstrap-server "${bootstrap}" --alter \
      --entity-type topics --entity-name "${name}" --add-config "${configs}"
  fi
done < "${topics_file}"

"${kafka_topics}" --bootstrap-server "${bootstrap}" --describe
