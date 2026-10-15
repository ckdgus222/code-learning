import { create } from 'zustand';

export type View = 'overview' | 'flow' | 'code' | 'changes';

interface Selection {
  view: View;
  symbolId: string | null;
  stepId: string | null;
  setView(view: View): void;
  selectSymbol(id: string | null): void;
  selectStep(id: string | null): void;
}
// Only view selection belongs here; file authority and job cancellation stay in main.
export const useSelection = create<Selection>(set => ({
  view: 'overview',
  symbolId: null, stepId: null,
  setView: view => set({ view }),
  selectSymbol: symbolId => set({ symbolId, stepId: null }),
  selectStep: stepId => set({ stepId }),
}));
