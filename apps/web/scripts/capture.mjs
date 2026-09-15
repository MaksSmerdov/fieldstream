import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;

/**
 * Картинки для README снимаются с живого стенда, а не рисуются руками: иначе они устаревают
 * молча и через месяц показывают интерфейс, которого уже нет. Запуск: pnpm --filter
 * @fieldstream/web run shots при поднятом стенде на http://localhost:8080.
 */
const BASE = process.env.SHOTS_BASE ?? 'http://localhost:8080';
const EMAIL = process.env.E2E_EMAIL ?? 'engineer@fieldstream.local';
const PASSWORD = process.env.E2E_PASSWORD ?? 'fieldstream';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'media');

const SHOT = { width: 1440, height: 900 };
const GIF = { width: 960, height: 600, frameMs: 320 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const signIn = async (page) => {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Почта').fill(EMAIL);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByRole('heading', { name: 'Обзор' }).waitFor();
};

/** Кадры GIF копятся в памяти сырыми пикселями: перекодировать их в файлы незачем. */
let frames = [];

const grab = async (page) => {
  const png = PNG.sync.read(await page.screenshot({ type: 'png' }));
  frames.push({ data: new Uint8ClampedArray(png.data), width: png.width, height: png.height });
};

const record = async (page, seconds, action) => {
  const until = Date.now() + seconds * 1000;
  const running = action?.();
  while (Date.now() < until) {
    await grab(page);
    await sleep(GIF.frameMs);
  }
  await running;
};

/** Кадры, пока на экране не появится ожидаемое, но не дольше предела: ролик не зависает на сломанном стенде. */
const recordUntil = async (page, locator, seconds) => {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await grab(page);
    if (await locator.isVisible()) return true;
    await sleep(GIF.frameMs);
  }
  return false;
};

const encodeGif = async (path) => {
  const encoder = GIFEncoder();
  for (const frame of frames) {
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    encoder.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: GIF.frameMs,
    });
  }
  encoder.finish();
  await writeFile(path, Buffer.from(encoder.bytes()));
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'chrome' });

  // Снимки экранов: полный размер, тёмная тема как на стенде по умолчанию
  const shots = await browser.newContext({ viewport: SHOT, deviceScaleFactor: 1 });
  const page = await shots.newPage();

  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'Войти' }).waitFor();
  await sleep(800);
  await page.screenshot({ path: join(OUT, 'login.png') });

  await signIn(page);
  await sleep(1500);
  await page.screenshot({ path: join(OUT, 'overview.png') });

  await page.goto(`${BASE}/device/RC-101`);
  await page.getByRole('img', { name: /График прибора/ }).waitFor();
  await sleep(2500);
  await page.screenshot({ path: join(OUT, 'device.png') });

  await page.getByRole('tab', { name: 'Уставки' }).click();
  await page.getByText('Уставки по режимам').waitFor();
  await sleep(800);
  await page.screenshot({ path: join(OUT, 'rules.png') });

  await page.getByRole('tab', { name: 'Карта регистров' }).click();
  await page.getByText(/запросов:/).waitFor();
  await sleep(500);
  await page.screenshot({ path: join(OUT, 'read-plan.png') });

  await page.goto(`${BASE}/alarms`);
  await page.getByRole('heading', { name: 'Алармы' }).waitFor();
  await sleep(1500);
  await page.screenshot({ path: join(OUT, 'alarms.png') });

  await page.goto(`${BASE}/pipeline`);
  await page.getByRole('region', { name: 'Группа fs-processor', exact: true }).waitFor();
  await sleep(5000);
  await page.screenshot({ path: join(OUT, 'pipeline.png') });

  await page.goto(`${BASE}/lab`);
  await page.getByText('Время ответа').waitFor();
  await sleep(2000);
  await page.screenshot({ path: join(OUT, 'lab.png') });

  const scenarios = page.getByRole('region', { name: 'Сценарии', exact: true });
  await scenarios.getByRole('button', { name: 'Запустить' }).first().waitFor();
  await scenarios.scrollIntoViewIfNeeded();
  await sleep(800);
  await page.screenshot({ path: join(OUT, 'scenarios.png') });

  // Перепрогон: последний готовый прогон или новый с примером правки за час
  await page.goto(`${BASE}/replay`);
  await page.getByRole('region', { name: 'Последние перепрогоны', exact: true }).waitFor();
  await sleep(1500);
  const replayForm = page.getByRole('region', { name: 'Новый перепрогон', exact: true });
  const replayResult = page.getByRole('region', { name: 'Разница срабатываний', exact: true });
  if (!(await replayResult.isVisible())) {
    try {
      const submit = replayForm.getByRole('button', { name: 'Поставить перепрогон' });
      await replayForm.getByRole('button', { name: 'Граница испарителя в оттайке +8' }).click();
      await replayForm.getByRole('button', { name: '1 ч', exact: true }).click();
      for (let second = 0; second < 120; second += 1) {
        if ((await submit.getAttribute('aria-disabled')) !== 'true') break;
        await sleep(1000);
      }
      await submit.click({ timeout: 5_000 });
    } catch {
      process.stdout.write(
        'перепрогон не поставлен: стенд занят чужим прогоном, снимок как есть\n',
      );
    }
  }
  try {
    await replayResult.waitFor({ timeout: 180_000 });
    await page
      .getByRole('img', { name: /^График RC-/ })
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
  } catch {
    process.stdout.write('перепрогон не завершился за 3 мин, снимок без итога\n');
  }
  await replayResult.scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(1500);
  await page.screenshot({ path: join(OUT, 'replay.png') });
  await shots.close();

  // Ролик: обзор с живыми значениями, переход на прибор, смена окна графика
  const film = await browser.newContext({ viewport: GIF, deviceScaleFactor: 1 });
  const stage = await film.newPage();
  await signIn(stage);
  await sleep(1200);

  await record(stage, 3);
  await record(stage, 2, async () => {
    await stage.getByRole('link', { name: 'RC-101' }).click();
    await stage.getByRole('img', { name: /График прибора/ }).waitFor();
  });
  await record(stage, 3);
  await record(stage, 3, async () => {
    await stage.getByRole('button', { name: 'сутки' }).click();
  });
  await record(stage, 2, async () => {
    await stage.getByRole('tab', { name: 'Алармы' }).click();
    await stage.getByRole('heading', { name: 'Алармы' }).waitFor();
  });
  await record(stage, 2);
  await encodeGif(join(OUT, 'tour.gif'));
  const tourFrames = frames.length;
  frames = [];

  await stage.goto(`${BASE}/lab?device=RC-105`);
  await stage.getByRole('heading', { name: 'Прибор RC-105 на линии L2' }).waitFor();
  const silent = stage
    .getByRole('group', { name: 'Поломки прибора RC-105' })
    .getByRole('switch', { name: 'молчит' });
  await sleep(1500);
  await record(stage, 2);
  await silent.click();
  try {
    const opened = await recordUntil(stage, stage.getByText('разомкнут', { exact: true }), 45);
    if (!opened) process.stdout.write('размыкатель не разомкнулся за 45 с, ролик неполный\n');
    await record(stage, 3);
  } finally {
    await silent.click();
  }
  await record(stage, 2);
  await film.close();
  await browser.close();

  await encodeGif(join(OUT, 'lab.gif'));
  process.stdout.write(
    `снято: 10 картинок, обзор из ${String(tourFrames)} кадров, отказы из ${String(frames.length)} кадров\n`,
  );
};

await main();
