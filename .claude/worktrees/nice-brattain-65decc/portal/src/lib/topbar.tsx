/**
 * Topbar context — shared state for the command palette and the global
 * search input (so the `/` hotkey can focus it from anywhere). Page-level
 * list filtering lives on the pages themselves; the topbar search is
 * GLOBAL and navigates to records.
 */

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

interface TopbarState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean | ((v: boolean) => boolean)) => void;
  searchRef: RefObject<HTMLInputElement>;
}

const TopbarContext = createContext<TopbarState | null>(null);

export function TopbarProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <TopbarContext.Provider value={{ paletteOpen, setPaletteOpen, searchRef }}>
      {children}
    </TopbarContext.Provider>
  );
}

export function useTopbar(): TopbarState {
  const ctx = useContext(TopbarContext);
  if (!ctx) throw new Error('useTopbar must be used within TopbarProvider');
  return ctx;
}
