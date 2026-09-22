import { fileURLToPath } from 'node:url';
import { checkDocs } from './check.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const result = await checkDocs(ROOT);
const counted = `${String(result.docs)} документов, ${String(result.links)} ссылок, ${String(result.mentions)} путей`;

if (result.findings.length === 0) {
  process.stdout.write(`docs-links: ${counted}, всё на месте\n`);
} else {
  const lines = result.findings.map(
    (finding) => `  ${finding.file}:${String(finding.line)}  ${finding.what}: ${finding.why}`,
  );

  process.stderr.write(
    `docs-links: ${counted}, не сходится ${String(result.findings.length)}\n${lines.join('\n')}\n`,
  );
  process.exitCode = 1;
}
