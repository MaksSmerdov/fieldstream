module.exports = {
  forbidden: [
    {
      name: 'contracts-are-leaf',
      comment: 'contracts не зависит ни от одного пакета workspace',
      severity: 'error',
      from: { path: '^packages/contracts' },
      to: { path: '^packages/(?!contracts)' },
    },
    {
      name: 'domain-is-pure',
      comment: 'domain не знает про ввод-вывод',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { path: 'node_modules/(kafkajs|pg|drizzle-orm|@nestjs)' },
    },
    {
      name: 'no-service-to-service',
      comment: 'сервис никогда не импортирует другой сервис',
      severity: 'error',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/([^/]+)/', pathNot: '^services/$1/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
};
