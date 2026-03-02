"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const root = document.documentElement;
    const saved = localStorage.getItem("prayer-theme") as "dark" | "light" | null;
    const next = saved ?? "dark";
    setTheme(next);
    root.classList.toggle("dark", next === "dark");
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("prayer-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  return (
    <button
      onClick={toggle}
      className="fixed top-4 right-4 z-[100] px-3 py-2 rounded-full border border-slate-300/70 dark:border-slate-700/70 bg-white/70 dark:bg-slate-900/65 backdrop-blur-md text-xs font-semibold shadow-sm"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
    </button>
  );
}
