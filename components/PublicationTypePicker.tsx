import React, { useEffect, useRef } from 'react';

// 5 user-facing rows. Each row groups one or more DB enum values from
// works.publication_type. "Other" is the long tail — books, chapters,
// conference papers, preprints, datasets, dissertations, anything else.
// Underlying enum values stay on each row so backend filtering keeps
// working unchanged.
const PUB_TYPE_ROWS: { id: string; label: string; hint: string; enumValues: string[] }[] = [
  {
    id: 'journal_article',
    label: 'Peer-reviewed journal',
    hint: 'Articles in academic journals',
    enumValues: ['journal_article'],
  },
  {
    id: 'working_paper',
    label: 'Working paper',
    hint: 'NBER, SSRN, IADB working papers, etc.',
    enumValues: ['working_paper'],
  },
  {
    id: 'discussion_paper',
    label: 'Discussion paper',
    hint: 'Institutional discussion series',
    enumValues: ['discussion_paper'],
  },
  {
    id: 'report',
    label: 'Report',
    hint: 'Policy reports, technical reports',
    enumValues: ['report'],
  },
  {
    id: 'other',
    label: 'Other',
    hint: 'Books, chapters, conference, preprints, datasets, dissertations',
    enumValues: [
      'book',
      'book_chapter',
      'conference_paper',
      'preprint',
      'dataset',
      'dissertation',
      'other',
    ],
  },
];

// Flat list of all enum values across rows — used for select-all and
// "everything" detection on the chip label.
export const ALL_PUB_TYPE_IDS = PUB_TYPE_ROWS.flatMap((r) => r.enumValues);

interface PublicationTypePickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}

// Row is considered "selected" when at least one of its underlying enum
// values is in the filter. Toggling adds/removes the entire group.
const rowIsSelected = (row: typeof PUB_TYPE_ROWS[number], selected: string[]): boolean =>
  row.enumValues.some((v) => selected.includes(v));

export const summarisePublicationTypes = (selected: string[] | undefined): string => {
  if (!selected || selected.length === 0) return 'All types';
  const selectedRows = PUB_TYPE_ROWS.filter((r) => rowIsSelected(r, selected));
  if (selectedRows.length === PUB_TYPE_ROWS.length) return 'All types';
  if (selectedRows.length === 1) return selectedRows[0].label;
  if (selectedRows.length === 2) return selectedRows.map((r) => r.label).join(' + ');
  return `${selectedRows.length} types`;
};

export const PublicationTypePicker: React.FC<PublicationTypePickerProps> = ({ value, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const toggleRow = (row: typeof PUB_TYPE_ROWS[number]) => {
    if (rowIsSelected(row, value)) {
      // Remove all enum values for this row.
      onChange(value.filter((v) => !row.enumValues.includes(v)));
    } else {
      // Add all enum values for this row (de-duped).
      const set = new Set(value);
      for (const v of row.enumValues) set.add(v);
      onChange([...set]);
    }
  };

  const selectAll = () => onChange([...ALL_PUB_TYPE_IDS]);
  const clearAll = () => onChange([]);

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 w-[440px] bg-white border border-slate-200 rounded-2xl shadow-xl p-5 z-50"
      onClick={(e) => e.stopPropagation()}
    >
      <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">Publication type</h4>
      <div className="space-y-1">
        {PUB_TYPE_ROWS.map((row) => (
          <label key={row.id} className="flex items-start gap-3 px-2 py-2 rounded-md hover:bg-slate-100 cursor-pointer">
            <input
              type="checkbox"
              checked={rowIsSelected(row, value)}
              onChange={() => toggleRow(row)}
              className="accent-teal-600 mt-0.5"
            />
            <div className="flex-1">
              <div className="text-sm font-semibold text-slate-900">{row.label}</div>
              <div className="text-xs text-slate-600 mt-0.5">{row.hint}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="flex justify-between items-center pt-3 mt-3 border-t border-slate-200">
        <div className="flex gap-3">
          <button onClick={selectAll} className="text-xs text-teal-700 hover:text-teal-900 font-medium">Select all</button>
          <button onClick={clearAll} className="text-xs text-slate-500 hover:text-slate-700 font-medium">Clear</button>
        </div>
        <button onClick={onClose} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">Done</button>
      </div>
    </div>
  );
};

export default PublicationTypePicker;
