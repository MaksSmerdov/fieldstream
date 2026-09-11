/** Инерционное звено первого порядка: величина тянется к цели с постоянной времени tauSec. */
export const lag = (current: number, target: number, dtSec: number, tauSec: number): number =>
  current + (target - current) * Math.min(1, dtSec / tauSec);
