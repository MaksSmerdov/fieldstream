/// <reference types="vite/client" />

/** Стили подключаются модулями: обращение только через ключ, как того требуют соглашения проекта. */
declare module '*.module.scss' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
