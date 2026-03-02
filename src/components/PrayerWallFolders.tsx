'use client';

import { useMemo, useState } from 'react';
import { PrayerCard } from '@/components/PrayerCard';

type Req = { id: number; content: string; createdAt: string };

type DayGroup = { dayKey: string; dateLabel: string; items: Req[] };
type MonthGroup = { monthKey: string; monthLabel: string; days: DayGroup[] };
type YearGroup = { yearKey: string; yearLabel: string; months: MonthGroup[] };

function groupByDate(requests: Req[]): YearGroup[] {
  const byYear = new Map<string, Map<string, Map<string, Req[]>>>();

  for (const req of requests) {
    const d = new Date(req.createdAt);
    const year = String(d.getFullYear());
    const month = d.toLocaleString('en-US', { month: 'long' });
    const monthKey = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dayKey = `${monthKey}-${String(d.getDate()).padStart(2, '0')}`;

    if (!byYear.has(year)) byYear.set(year, new Map());
    const months = byYear.get(year)!;
    if (!months.has(monthKey)) months.set(monthKey, new Map());
    const days = months.get(monthKey)!;
    if (!days.has(dayKey)) days.set(dayKey, []);
    days.get(dayKey)!.push(req);

    // store label metadata on arrays (quick lightweight approach)
    (days.get(dayKey)! as Req[] & { _month?: string; _date?: string })._month = month;
    (days.get(dayKey)! as Req[] & { _month?: string; _date?: string })._date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  return [...byYear.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([yearKey, monthsMap]) => ({
      yearKey,
      yearLabel: yearKey,
      months: [...monthsMap.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([monthKey, daysMap]) => {
          const firstItems = daysMap.values().next().value as (Req[] & { _month?: string }) | undefined;
          const monthLabel = firstItems?._month || monthKey;
          return {
            monthKey,
            monthLabel,
            days: [...daysMap.entries()]
              .sort((a, b) => b[0].localeCompare(a[0]))
              .map(([dayKey, items]) => {
                const typed = items as Req[] & { _date?: string };
                return {
                  dayKey,
                  dateLabel: typed._date || dayKey,
                  items,
                };
              }),
          };
        }),
    }));
}

export function PrayerWallFolders({ requests }: { requests: Req[] }) {
  const [foldersEnabled, setFoldersEnabled] = useState(false);
  const [openYears, setOpenYears] = useState<Record<string, boolean>>({});
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => groupByDate(requests), [requests]);

  if (!foldersEnabled) {
    return (
      <>
        <button
          onClick={() => setFoldersEnabled(true)}
          className="w-full mb-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800/50"
        >
          Create Date Folders (Year / Month / Day)
        </button>

        {requests.map((req, i) => (
          <PrayerCard key={req.id} request={req} index={i} />
        ))}
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => setFoldersEnabled(false)}
        className="w-full mb-4 py-2.5 rounded-xl border border-primary/40 text-sm font-medium text-primary hover:bg-primary/10"
      >
        Back to Flat Wall View
      </button>

      <div className="space-y-3">
        {grouped.map((year) => (
          <div key={year.yearKey} className="rounded-xl border border-slate-200 dark:border-slate-800/60">
            <button
              onClick={() => setOpenYears((s) => ({ ...s, [year.yearKey]: !s[year.yearKey] }))}
              className="w-full flex items-center justify-between px-4 py-3 text-left"
            >
              <span className="font-semibold">📁 {year.yearLabel}</span>
              <span>{openYears[year.yearKey] ? '−' : '+'}</span>
            </button>

            {openYears[year.yearKey] && (
              <div className="px-3 pb-3 space-y-2">
                {year.months.map((month) => (
                  <div key={month.monthKey} className="rounded-lg border border-slate-200/70 dark:border-slate-800/70">
                    <button
                      onClick={() => setOpenMonths((s) => ({ ...s, [month.monthKey]: !s[month.monthKey] }))}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                    >
                      <span>🗂️ {month.monthLabel}</span>
                      <span>{openMonths[month.monthKey] ? '−' : '+'}</span>
                    </button>

                    {openMonths[month.monthKey] && (
                      <div className="px-2 pb-2 space-y-2">
                        {month.days.map((day) => (
                          <div key={day.dayKey} className="rounded-md border border-slate-200/60 dark:border-slate-800/60">
                            <button
                              onClick={() => setOpenDays((s) => ({ ...s, [day.dayKey]: !s[day.dayKey] }))}
                              className="w-full flex items-center justify-between px-3 py-2 text-left text-sm"
                            >
                              <span>📄 {day.dateLabel}</span>
                              <span>{openDays[day.dayKey] ? '−' : '+'}</span>
                            </button>

                            {openDays[day.dayKey] && (
                              <div className="px-2 pb-2 space-y-2">
                                {day.items.map((req, i) => (
                                  <PrayerCard key={req.id} request={req} index={i} />
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
