import React, { useState, useMemo } from 'react';
import {
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Table as TableIcon,
} from 'lucide-react';

interface DataTableProps {
  data: Record<string, any>[];
  columns?: string[];
  title?: string;
  pageSize?: number;
}

export const DataTable: React.FC<DataTableProps> = ({
  data,
  columns: customColumns,
  title = '明细查询结果数据',
  pageSize = 10,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);

  // Auto detect columns if not provided
  const columns = useMemo(() => {
    if (customColumns && customColumns.length > 0) return customColumns;
    if (!data || data.length === 0) return [];
    return Object.keys(data[0]);
  }, [data, customColumns]);

  // Filtered & Sorted data
  const filteredData = useMemo(() => {
    if (!data) return [];
    return data.filter((row) => {
      if (!searchTerm) return true;
      return Object.values(row).some((val) =>
        String(val ?? '')
          .toLowerCase()
          .includes(searchTerm.toLowerCase())
      );
    });
  }, [data, searchTerm]);

  const sortedData = useMemo(() => {
    if (!sortColumn) return filteredData;
    return [...filteredData].sort((a, b) => {
      const valA = a[sortColumn];
      const valB = b[sortColumn];

      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortDirection === 'asc' ? valA - valB : valB - valA;
      }
      return sortDirection === 'asc'
        ? String(valA ?? '').localeCompare(String(valB ?? ''))
        : String(valB ?? '').localeCompare(String(valA ?? ''));
    });
  }, [filteredData, sortColumn, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(sortedData.length / pageSize) || 1;
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, currentPage, pageSize]);

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      if (sortDirection === 'asc') setSortDirection('desc');
      else setSortColumn(null);
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  };

  // CSV Export
  const exportCSV = () => {
    if (!data || data.length === 0) return;
    const headerRow = columns.join(',');
    const bodyRows = data.map((row) =>
      columns
        .map((col) => {
          const cell = row[col] ?? '';
          return `"${String(cell).replace(/"/g, '""')}"`;
        })
        .join(',')
    );
    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headerRow, ...bodyRows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${title || 'export_data'}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!data || data.length === 0) {
    return (
      <div className="p-6 text-center text-slate-400 text-xs bg-slate-900/50 border border-slate-800 rounded-xl">
        无结果明细数据
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-sm space-y-3">
      {/* Table Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex items-center space-x-2">
          <TableIcon className="w-4 h-4 text-indigo-400" />
          <h3 className="font-semibold text-sm text-slate-200">{title}</h3>
          <span className="px-2 py-0.5 text-[11px] font-mono bg-slate-800 text-slate-400 rounded-full">
            共 {sortedData.length} 条
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {/* Search Box */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="搜索表格内容..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-700/80 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500 w-36 sm:w-48"
            />
          </div>

          {/* Export CSV Button */}
          <button
            onClick={exportCSV}
            className="flex items-center space-x-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">导出 CSV</span>
          </button>
        </div>
      </div>

      {/* Responsive Table Container */}
      <div className="overflow-x-auto border border-slate-800 rounded-xl">
        <table className="w-full text-left text-xs text-slate-300 divide-y divide-slate-800">
          <thead className="bg-slate-950 text-slate-400 font-semibold uppercase text-[11px] select-none">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className="px-3.5 py-2.5 hover:bg-slate-900 cursor-pointer transition-colors whitespace-nowrap"
                >
                  <div className="flex items-center space-x-1">
                    <span>{col}</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-500" />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
            {paginatedData.map((row, rIdx) => (
              <tr
                key={rIdx}
                className="hover:bg-slate-800/50 transition-colors group"
              >
                {columns.map((col) => {
                  const cell = row[col];
                  const isNumber = typeof cell === 'number';
                  return (
                    <td
                      key={col}
                      className={`px-3.5 py-2.5 whitespace-nowrap ${
                        isNumber ? 'font-mono text-indigo-300' : 'text-slate-200'
                      }`}
                    >
                      {isNumber ? cell.toLocaleString() : String(cell ?? '-')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Table Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
        <div>
          第 {(currentPage - 1) * pageSize + 1} -{' '}
          {Math.min(currentPage * pageSize, sortedData.length)} 条，共 {sortedData.length} 条
        </div>
        <div className="flex items-center space-x-1">
          <button
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((p) => p - 1)}
            className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700"
          >
            <ChevronLeft className="w-4 h-4 text-slate-300" />
          </button>
          <span className="px-2 font-mono">
            {currentPage} / {totalPages}
          </span>
          <button
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((p) => p + 1)}
            className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700"
          >
            <ChevronRight className="w-4 h-4 text-slate-300" />
          </button>
        </div>
      </div>
    </div>
  );
};
