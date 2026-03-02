"use client";

import { useState } from 'react';

type DeletePayload = { id?: number; olderThanMinutes?: number; olderThanHours?: number; olderThanDays?: number };

export default function AdminPage() {
  const [password, setPassword] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);

  const [minutes, setMinutes] = useState(1);
  const [hours, setHours] = useState(1);
  const [days, setDays] = useState(30);
  const [postId, setPostId] = useState('');

  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const login = () => {
    if (!password.trim()) return;
    setLoggedIn(true);
    setStatus('Admin unlocked for this session.');
  };

  const callDelete = async (payload: DeletePayload) => {
    try {
      setLoading(true);
      setStatus('Processing...');
      const res = await fetch('/api/admin/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey: password, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error || 'Delete failed');
        return;
      }
      setStatus(`Deleted ${data.deleted} request(s).`);
    } catch {
      setStatus('Delete failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10 bg-black/5 dark:bg-black/20">
      <div className="w-full max-w-2xl hud-panel border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl">
        <div className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Admin Control</h1>
          <p className="text-sm text-slate-500 mt-1">Manage prayer wall cleanup safely.</p>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_auto] items-end mb-6">
          <div>
            <label className="text-sm font-medium">Admin Password</label>
            <input
              type="password"
              className="w-full mt-1 p-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-transparent"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter ADMIN_PASSWORD"
            />
          </div>
          <button
            onClick={login}
            className="px-5 py-3 rounded-xl bg-primary text-white cursor-pointer disabled:opacity-60"
            disabled={!password.trim()}
          >
            Login
          </button>
        </div>

        {loggedIn && (
          <div className="space-y-5 border-t border-slate-200 dark:border-slate-800 pt-6">
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <h2 className="font-semibold mb-3">Delete by age</h2>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm text-slate-500">Minutes</label>
                  <div className="flex gap-2">
                    <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value || 1))} className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
                    <button onClick={() => callDelete({ olderThanMinutes: minutes })} className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 whitespace-nowrap">Delete</button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm text-slate-500">Hours</label>
                  <div className="flex gap-2">
                    <input type="number" min={1} value={hours} onChange={(e) => setHours(Number(e.target.value || 1))} className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
                    <button onClick={() => callDelete({ olderThanHours: hours })} className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 whitespace-nowrap">Delete</button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm text-slate-500">Days</label>
                  <div className="flex gap-2">
                    <input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value || 1))} className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
                    <button onClick={() => callDelete({ olderThanDays: days })} className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 whitespace-nowrap">Delete</button>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <h2 className="font-semibold mb-3">Delete specific post</h2>
              <div className="flex flex-col md:flex-row gap-2">
                <input
                  type="number"
                  min={1}
                  value={postId}
                  onChange={(e) => setPostId(e.target.value)}
                  className="md:w-48 p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                  placeholder="Post ID"
                />
                <button
                  onClick={() => callDelete({ id: Number(postId) })}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                  disabled={!postId}
                >
                  Delete by ID
                </button>
              </div>
            </section>
          </div>
        )}

        {status && <p className="text-sm text-slate-500 mt-5">{loading ? '⏳ ' : '✅ '}{status}</p>}
      </div>
    </main>
  );
}
