import type { BoardState, ReadinessProblem } from '@innpilot/contracts';

/** The board's derived state, expressed as a check-in readiness problem (null = ready). */
export function readinessFromBoard(state: BoardState): ReadinessProblem | null {
  switch (state) {
    case 'vacant_ready':
      return null;
    case 'vacant_dirty':
      return 'dirty';
    case 'cleaning':
      return 'cleaning';
    case 'occupied':
      return 'occupied';
    case 'out_of_order':
      return 'out_of_order';
    case 'inactive':
      return 'inactive';
  }
}
