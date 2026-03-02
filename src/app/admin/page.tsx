"use client";

import { useState } from 'react';

export default function AdminPage() {
  const [password, setPassword] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [days, setDays] = useState(30);
  const [postId, setPostId] = useState('');
  const [status, setStatus] = useState('');

  const login = () => {
    if (!password.trim()) return;
    setLoggedIn(true);
    setStatus('Admin unlocked for this session.');
  };

  const callDelete = async (payload: Record<string, unknown>) => {
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
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10 bg-black/5 dark:bg-black/20">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5 hud-panel shadow-2xl">
        <h1 className="text-2xl font-bold">Admin Control</h1>
        <p className="text-sm text-slate-500">Login and delete older prayer posts safely.</p>

        <div className="space-y-2">
          <label className="text-sm">Admin Password</label>
          <input
            type="password"
            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter ADMIN_PASSWORD"
          />
          <button onClick={login} className="px-4 py-2 rounded-lg bg-primary text-white cursor-pointer">Login</button>
        </div>

        {loggedIn && (
          <div className="space-y-4 border-t border-slate-200 dark:border-slate-800 pt-4">
            <div className="space-y-2">
              <h2 className="font-semibold">Delete old posts</h2>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value || 1))}
                  className="w-32 p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                />
                <button onClick={() => callDelete({ olderThanDays: days })} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer">
                  Delete older than X days
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="font-semibold">Delete by post ID</h2>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={postId}
                  onChange={(e) => setPostId(e.target.value)}
                  className="w-32 p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                  placeholder="ID"
                />
                <button
                  onClick={() => callDelete({ id: Number(postId) })}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                  disabled={!postId}
                >
                  Delete post
                </button>
              </div>
            </div>
          </div>
        )}

        {status && <p className="text-sm text-slate-500">{status}</p>}
      </div>
    </main>
  );
}
