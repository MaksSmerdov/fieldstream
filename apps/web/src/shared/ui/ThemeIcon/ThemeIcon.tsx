interface Props {
  readonly mode: 'light' | 'dark';
}

/** Солнце и месяц рисунком, а не знаком шрифта: у текстовых знаков размер и вид зависят от шрифта. */
export const ThemeIcon = ({ mode }: Props): React.JSX.Element =>
  mode === 'dark' ? (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M20.7 14.9a8.7 8.7 0 0 1-11.6-11.6 1 1 0 0 0-1.3-1.3 10.6 10.6 0 1 0 14.2 14.2 1 1 0 0 0-1.3-1.3Z" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5" />
    </svg>
  );
