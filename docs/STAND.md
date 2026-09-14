# Работа со стендом

Как поднять стенд, написано в [README](../README.md). Здесь то, что с ним можно делать дальше.

---

## Приборы и поломки

Симулятор слушает Modbus TCP на портах 5020..5023 (линии L1..L4) и отдаёт управляющий API на порту 8090:

```bash
curl localhost:8090/sim/state
curl -X POST localhost:8090/sim/fault -H 'content-type: application/json' \
  -d '{"targetKind":"device","targetId":"RC-104","kind":"silent","ttlSec":120}'
curl -X POST localhost:8090/sim/scenario/night-defrost
curl -X DELETE "localhost:8090/sim/faults?targetId=RC-104&kind=silent"
curl -X DELETE localhost:8090/sim/faults
```

Виды поломок: `silent`, `crc`, `stall`, `exception`, `offline` (порт шлюза закрыт), `power_dip`, `offscale`, `door_stuck`, `defrost`. `GET /sim/state` отдаёт эталон: значения всех приборов, действующие поломки и счётчики запросов по линиям.

`DELETE /sim/faults` без параметров снимает все поломки. Параметры `targetId` (код линии или прибора) и `kind` сужают выбор и сочетаются: фильтр по прибору снимает только поломки, внесённые на сам прибор, а поломки его линии остаются. В ответ приходит число снятых поломок, `{"removed":1}`; неверный фильтр даёт 400.

Время ответа прибора складывается из передачи кадров на скорости линии, постоянной задержки `SIM_TURNAROUND_MS` и случайной добавки до `SIM_TURNAROUND_JITTER_MS` (по умолчанию 40 мс). Добавка чаще всего мала и лишь изредка дотягивает до предела, поэтому у времени ответа длинный хвост, как у настоящих приборов. Последовательность добавок своя у каждой линии и повторяется при том же `SIM_SEED`. Зависший обмен (`stall`) обходится без случайной добавки и ждёт сверх обычного времени `SIM_STALL_MS`.

Сборщик опрашивает все четыре линии и пишет сырые кадры в `fieldstream.telemetry.raw.v1` (ключ это код прибора), а итог каждого обращения, в том числе неудачного, в `fieldstream.collector.cycles.v2` (ключ тоже код прибора). Портов наружу у него нет, состояние воркеров, размыкателей и планов чтения смотрится изнутри сети:

```bash
docker compose -f infra/compose/docker-compose.yml exec edge-collector wget -qO- 127.0.0.1:8091/internal/lines
```

Процессор разбирает кадр той версией профиля, которой он прочитан, и пишет показания в `ts.readings`, итоги опроса в `ts.poll_cycles`, а состояние приборов в `core.device_state` и в компактируемый топик `fieldstream.device.state.v1`. Кадр, который не разобрать, уходит в `fieldstream.telemetry.raw.dlq.v1` сырыми байтами с исходным ключом, и поток идёт дальше. Минутный агрегат по прибору:

```bash
docker compose -f infra/compose/docker-compose.yml exec timescaledb psql -U fieldstream -d fieldstream \
  -c "select bucket, metric_key, round(avg_value::numeric, 2), n from ts.v_readings_1m where device_id = 1 order by bucket desc limit 9"
```

---

## Доступ к API

Шлюз слушает 8093 внутри сети, наружу его пути отдаёт nginx на 8080. Учётные записи стенда заводит мигратор, пароль берётся из `DEMO_PASSWORD`: `viewer@fieldstream.local` (только чтение), `engineer@fieldstream.local` (подтверждение алармов, уставки, команды), `admin@fieldstream.local`.

```bash
token=$(curl -s localhost:8080/api/auth/login -H 'content-type: application/json'   -d '{"email":"engineer@fieldstream.local","password":"fieldstream"}' | jq -r .accessToken)

curl -s localhost:8080/api/topology -H "authorization: Bearer $token"          # дерево объектов с состоянием
curl -s localhost:8080/api/devices/RC-101/latest -H "authorization: Bearer $token"
curl -s "localhost:8080/api/devices/RC-101/read-plan?mode=naive" -H "authorization: Bearer $token"
curl -s "localhost:8080/api/alarms?state=active" -H "authorization: Bearer $token"
```

Серия сама выбирает источник по ширине окна и говорит, откуда взяла числа: до шести часов это сырые строки, до недели минутный агрегат, дальше часовой. Источник, шаг и признак обрезки приходят вместе с данными, поэтому подпись под графиком не может разойтись с содержимым:

```bash
curl -s "localhost:8080/api/devices/RC-101/series?metrics=supply_temp_c&from=2026-09-05T00:00:00Z&to=2026-09-12T00:00:00Z"   -H "authorization: Bearer $token" | jq .meta
# {"source":"readings_1m","bucketMs":1260000,"points":480,"truncated":false, ...}
```

Живой канал это одно соединение на вкладку. Первым кадром приходит приветствие с серверным временем и эпохой, дальше показания, состояния приборов и алармы. При обрыве браузер присылает `Last-Event-ID`, и шлюз либо досылает пропущенное, либо честно требует перечитать всё:

```bash
curl -N "localhost:8080/api/events?keys=device:RC-101&access_token=$token"
```

Команда линии не уходит в брокер прямо из запроса: она ложится в очередь исходящих той же транзакцией, в которой её приняли, а отправкой занимается фоновая рассылка. Применяет её сборщик и отвечает через брокер, в таблицу ответ переносит процессор:

```bash
id=$(curl -s localhost:8080/api/commands -H "authorization: Bearer $token" -H 'content-type: application/json'   -d '{"lineCode":"L1","kind":"line.set_poll_interval","args":{"pollIntervalMs":15000}}' | jq -r .commandId)
curl -s localhost:8080/api/commands/$id -H "authorization: Bearer $token"
# {"stage":"applied","detail":"такт опроса линии L1 теперь 15000 мс", ...}
```

---

## Засев истории и брокер

Историю на неделю назад заливает одноразовый контейнер: он поднимается вместе со стендом, а
повторить засев можно командой `pnpm stack:seed`. Строки не едут по сети, их порождает сама
база, поэтому неделя на 24 прибора занимает секунды. Повторный запуск ничего не добавляет и не
пишет поверх живых значений. В засеянной истории лежат три происшествия и оттайки по расписанию,
чтобы на экранах было что показывать.

Kafka доступна с хоста на `localhost:29092`, веб-интерфейс к ней поднимается профилем: `docker compose -f infra/compose/docker-compose.yml --profile tools up -d kafka-ui` (http://localhost:8081).

Для ежедневной разработки без пересборки образов `pnpm infra:up` поднимает брокер, базу и
применяет миграции, а `pnpm dev` запускает сервисы на хосте в режиме наблюдения за файлами
(переменные берутся из `.env`). В этом режиме фронт живёт на дев-сервере vite (5173) и ходит в
шлюз на 8093, то есть в два origin: `.env` для этого и держит `CORS_ORIGINS`.

---

## Проверки

Сценарии Playwright идут против поднятого стенда:

```bash
pnpm --filter @fieldstream/web exec playwright test          # против http://localhost:8080
E2E_BASE_URL=http://127.0.0.1:5173 pnpm --filter @fieldstream/web exec playwright test
```

По умолчанию сценарии берут установленный Chrome, чтобы не качать браузер ради локального
прогона. Пустая `E2E_CHANNEL` переключает их на браузер, который ставит сам Playwright.

Проверки собраны в два потока. Быстрый идёт на каждый пуш: сборка, типы, линтер, формат,
границы зависимостей и модульные тесты. Тяжёлый поднимает настоящие Kafka, TimescaleDB и весь
стенд в Docker, поэтому запускается по расписанию и по кнопке: интеграционные тесты и сценарии
интерфейса против контейнера.

---

## Замеры

Сняты на стенде из 24 приборов с тактом опроса 10 секунд, машина обычная рабочая (Windows, Docker с WSL2).

| Что                                        | Значение                           |
| ------------------------------------------ | ---------------------------------- |
| Засев недели истории в минутном разрешении | 1.69 млн строк за 9 секунд         |
| Сжатие TimescaleDB на засеянной неделе     | 179 МБ до, 7 МБ после, пять кусков |
| Память: сборщик / процессор / шлюз         | 78 / 84 / 80 МБ                    |
| Память: симулятор стенда                   | 28 МБ                              |
| Память: TimescaleDB / Kafka                | 626 МБ / 742 МБ                    |

Сжатие измерено по самим сжатым кускам, без горячих суток и индексов. На засеянных данных оно
завышено: сгенерированные кривые гладкие, настоящие показания шумят и жмутся хуже.
