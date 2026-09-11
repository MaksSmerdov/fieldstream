-- Up Migration
DO $$
DECLARE
  installed text := (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb');
BEGIN
  IF installed IS NULL THEN
    RAISE EXCEPTION 'расширение timescaledb не установлено в базе';
  END IF;
  IF string_to_array(split_part(installed, '-', 1), '.')::int[] < ARRAY[2, 17] THEN
    RAISE EXCEPTION 'нужен TimescaleDB 2.17 или новее, установлен %', installed;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'timescaledb_toolkit') THEN
    RAISE EXCEPTION 'расширение timescaledb_toolkit не установлено: percentile_agg недоступен';
  END IF;
END $$;

-- Down Migration
SELECT 1;
