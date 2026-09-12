import '@testing-library/jest-dom/vitest';

/**
 * jsdom не умеет наблюдать размеры элементов, а виртуализированный список без этого
 * не рисует ни одной строки: заглушка позволяет проверять дерево объектов в тестах.
 */
class ResizeObserverStub {
  public observe(): void {
    return undefined;
  }

  public unobserve(): void {
    return undefined;
  }

  public disconnect(): void {
    return undefined;
  }
}

globalThis.ResizeObserver = ResizeObserverStub;
