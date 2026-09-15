import { useEffect, useState } from 'react';
import { getServerNowMs } from '../../../shared/time/serverClock.js';

/** Серверное время с перерисовкой по интервалу. */
export const useServerNow = (intervalMs = 1_000): number => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return getServerNowMs();
};
