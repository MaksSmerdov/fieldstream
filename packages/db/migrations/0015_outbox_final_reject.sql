-- Up Migration
-- Окончательный отказ в очереди исходящих. Строку, которую не принимает схема своего топика,
-- повторы не исправят: без отказа она вечно перекладывается на минуту вперёд и держит место
-- в очереди. Предел попыток тот же, что у очереди недоставленных, и отказанная строка уходит
-- из частичного индекса готовых к отправке
ALTER TABLE core.outbox ADD COLUMN final_rejected boolean NOT NULL DEFAULT false;

DROP INDEX core.outbox_due;
CREATE INDEX outbox_due ON core.outbox (next_attempt_at)
  WHERE published_at IS NULL AND NOT final_rejected;

-- Down Migration
DROP INDEX core.outbox_due;
CREATE INDEX outbox_due ON core.outbox (next_attempt_at) WHERE published_at IS NULL;
ALTER TABLE core.outbox DROP COLUMN final_rejected;
