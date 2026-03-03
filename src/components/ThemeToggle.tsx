"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
    const { theme, setTheme, systemTheme } = useTheme();
    const [mounted, setMounted] = useState(false);

    // useEffect only runs on the client, so now we can safely show the UI
    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return null;
    }

    const currentTheme = theme === "system" ? systemTheme : theme;

    return (
        <button
            onClick={() => setTheme(currentTheme === "dark" ? "light" : "dark")}
            className="fixed top-4 right-4 z-50 p-2 rounded-full bg-white/50 dark:bg-black/50 ios-blur opacity-80 hover:opacity-100 transition-opacity border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-center cursor-pointer"
            aria-label="Toggle theme"
        >
            <span className="material-icons-round text-slate-800 dark:text-slate-200 text-xl">
                {currentTheme === "dark" ? "light_mode" : "dark_mode"}
            </span>
        </button>
    );
}
