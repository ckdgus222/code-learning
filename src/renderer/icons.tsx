import React from 'react';

const paths = {
  folder: 'M3 7V4h6l2 3h10v13H3z',
  close: 'M6 6l12 12 M18 6L6 18',
  question: 'M4 3h16v14H9l-5 4z M9 7a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 14h.01',
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  map: 'M9 3h6v5H9z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4',
  flow: 'M5 3v12a4 4 0 0 0 4 4h10 M15 15l4 4-4 4 M5 7h14 M15 3l4 4-4 4',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  changes: 'M5 3v18 M19 3v18 M2 6h6 M16 18h6 M5 10c0 5 14-1 14 5',
  search: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  wrap: 'M3 5h18 M3 10h14a4 4 0 0 1 0 8h-5 M15 15l-3 3 3 3 M3 16h4',
  collapse: 'M4 3v18 M10 6l6 6-6 6',
  smaller: 'M2 18L7 5l5 13 M4 13h6 M16 12h6',
  larger: 'M2 18L7 5l5 13 M4 13h6 M16 12h6 M19 9v6',
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
