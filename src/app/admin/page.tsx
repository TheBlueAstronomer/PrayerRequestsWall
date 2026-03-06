"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { QRCodeSVG } from 'qrcode.react';

type Prayer = {
    id: number;
    content: string;
    createdAt: string;
};

export default function AdminPage() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [password, setPassword] = useState("");
    const [authError, setAuthError] = useState("");

    const [groupSetting, setGroupSetting] = useState("");
    const [savedGroupSetting, setSavedGroupSetting] = useState("");
    const [settingsMsg, setSettingsMsg] = useState("");

    const [prayers, setPrayers] = useState<Prayer[]>([]);
    const [qrCodeData, setQrCodeData] = useState<string | null>(null);
    const [isLoggingOut, setIsLoggingOut] = useState(false);

    // Initial load logic if authenticated
    useEffect(() => {
        if (isAuthenticated) {
            fetchSettings();
            fetchPrayers();
            fetchQrCode();
            const qrInterval = setInterval(fetchQrCode, 5000);
            return () => clearInterval(qrInterval);
        }
    }, [isAuthenticated]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const res = await fetch("/api/admin/auth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            });
            const data = await res.json();
            if (data.success) {
                setIsAuthenticated(true);
                setAuthError("");
            } else {
                setAuthError("Invalid password");
            }
        } catch (error) {
            setAuthError("Login failed");
        }
    };

    const fetchSettings = async () => {
        try {
            const res = await fetch("/api/admin/settings");
            const data = await res.json();
            if (data.success) {
                setGroupSetting(data.whatsapp_group_ids || "");
                setSavedGroupSetting(data.whatsapp_group_ids || "");
            }
        } catch (error) {
            console.error("Failed to fetch settings", error);
        }
    };

    const saveSettings = async () => {
        setSettingsMsg("Saving...");
        try {
            const res = await fetch("/api/admin/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ whatsapp_group_ids: groupSetting }),
            });
            if (res.ok) {
                setSettingsMsg("Settings saved!");
                setSavedGroupSetting(groupSetting);
                setTimeout(() => setSettingsMsg(""), 3000);
            } else {
                setSettingsMsg("Failed to save.");
            }
        } catch (error) {
            setSettingsMsg("Error saving.");
        }
    };

    const groupIds = savedGroupSetting.split(',').map(id => id.trim()).filter(id => id.length > 0);

    const removeGroupId = async (idToRemove: string) => {
        const newGroups = groupIds.filter(id => id !== idToRemove);
        const newSetting = newGroups.join(',');

        setSettingsMsg("Removing ID...");
        try {
            const res = await fetch("/api/admin/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ whatsapp_group_ids: newSetting }),
            });
            if (res.ok) {
                setGroupSetting(newSetting);
                setSavedGroupSetting(newSetting);
                setSettingsMsg("ID removed!");
                setTimeout(() => setSettingsMsg(""), 3000);
            } else {
                setSettingsMsg("Failed to remove ID.");
            }
        } catch (error) {
            setSettingsMsg("Error removing ID.");
        }
    };

    const fetchPrayers = async () => {
        try {
            const res = await fetch("/api/admin/prayers");
            const data = await res.json();
            if (data.success) {
                setPrayers(data.prayers || []);
            }
        } catch (error) {
            console.error("Failed to fetch prayers", error);
        }
    };

    const deletePrayer = async (id: number) => {
        if (!confirm("Are you sure you want to delete this prayer?")) return;
        try {
            const res = await fetch(`/api/admin/prayers?id=${id}`, { method: "DELETE" });
            if (res.ok) {
                setPrayers(prayers.filter(p => p.id !== id));
            }
        } catch (error) {
            console.error("Failed to delete prayer", error);
        }
    };

    const fetchQrCode = async () => {
        try {
            const res = await fetch("/api/admin/qr");
            const data = await res.json();
            if (data.success) {
                setQrCodeData(data.qr || null);
            }
        } catch (error) {
            console.error("Failed to fetch QR code", error);
        }
    };

    const handleLogout = async () => {
        if (!confirm("Are you sure you want to logout the WhatsApp bot? This will disconnect the current session.")) return;

        setIsLoggingOut(true);
        try {
            const res = await fetch("/api/admin/logout", { method: "POST" });
            const data = await res.json();
            if (!data.success) {
                alert("Failed to logout: " + (data.error || "Unknown error"));
            }
        } catch (error) {
            console.error("Failed to logout", error);
            alert("Failed to logout. Check console for details.");
        } finally {
            setIsLoggingOut(false);
            // We don't need to manually clear state here because 
            // the fetchQrCode interval will pick up the new QR code.
        }
    };

    if (!isAuthenticated) {
        return (
            <main className="flex-1 flex flex-col items-center justify-center px-4 w-full">
                <div className="w-full max-w-sm p-6 bg-white dark:bg-slate-900 rounded-xl shadow-md border border-slate-200 dark:border-slate-800">
                    <h1 className="text-2xl font-bold mb-6 text-center text-primary">Admin Access</h1>
                    <form onSubmit={handleLogin} className="flex flex-col gap-4">
                        <input
                            type="password"
                            placeholder="Password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent focus:ring-2 focus:ring-primary outline-none"
                        />
                        {authError && <p className="text-red-500 text-sm text-center">{authError}</p>}
                        <button type="submit" className="w-full bg-primary text-white p-3 rounded-lg font-medium hover:bg-primary/90 transition-colors">
                            Login
                        </button>
                    </form>
                    <div className="mt-4 text-center">
                        <Link href="/" className="text-sm text-slate-500 hover:underline">Back to Home</Link>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="flex-1 w-full max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-12 overflow-y-auto pb-32">
            <header className="mb-8 flex justify-between items-center pr-12 md:pr-0">
                <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Admin Dashboard</h1>
                <Link href="/" className="text-primary hover:underline font-medium">Exit Admin</Link>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

                {/* Configuration Section */}
                <section className="bg-white dark:bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800">
                    <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                        <span className="material-icons-round text-primary">settings</span>
                        WhatsApp Configuration
                    </h2>
                    <div className="flex flex-col gap-3">
                        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            Group/Chat IDs (comma-separated if multiple):
                        </label>
                        <input
                            type="text"
                            value={groupSetting}
                            onChange={(e) => setGroupSetting(e.target.value)}
                            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-primary outline-none"
                            placeholder="e.g. 12036312345678@g.us"
                        />
                        <button
                            onClick={saveSettings}
                            className="bg-primary text-white py-2 px-4 rounded-lg font-medium hover:bg-primary/90 self-start"
                        >
                            Save Settings
                        </button>
                        {settingsMsg && <p className="text-sm text-green-600 dark:text-green-400 mt-2">{settingsMsg}</p>}
                    </div>

                    {groupIds.length > 0 && (
                        <div className="mt-6 pt-4 border-t border-slate-200 dark:border-slate-800">
                            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Configured IDs:</h3>
                            <ul className="flex flex-col gap-2">
                                {groupIds.map(id => (
                                    <li key={id} className="flex items-center justify-between p-3 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                                        <span className="font-mono text-sm text-slate-600 dark:text-slate-400 break-all">{id}</span>
                                        <button
                                            onClick={() => removeGroupId(id)}
                                            className="ml-4 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors flex-shrink-0"
                                            title="Remove ID"
                                        >
                                            <span className="material-icons-round text-sm">delete</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </section>

                {/* QR Code Section */}
                <section className="bg-white dark:bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 flex flex-col items-center">
                    <h2 className="text-xl font-bold mb-4 flex items-center gap-2 self-start w-full">
                        <span className="material-icons-round text-primary">qr_code_scanner</span>
                        WhatsApp Authentication
                    </h2>
                    <div className="flex-1 flex flex-col items-center justify-center w-full min-h-[250px] bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                        {qrCodeData ? (
                            <div className="bg-white p-4 rounded-xl flex flex-col items-center gap-4">
                                <QRCodeSVG value={qrCodeData} size={200} />
                                <p className="text-sm text-slate-500 text-center">Scan to connect WhatsApp Bot</p>
                            </div>
                        ) : (
                            <div className="text-center text-slate-500 flex flex-col items-center gap-4">
                                <div className="flex flex-col items-center gap-2">
                                    <span className="material-icons-round text-4xl opacity-50 text-green-500">check_circle</span>
                                    <p className="font-medium text-slate-700 dark:text-slate-300">WhatsApp is connected.</p>
                                    <p className="text-xs">No QR code requested.</p>
                                </div>

                                <button
                                    onClick={handleLogout}
                                    disabled={isLoggingOut}
                                    className="mt-4 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/20 dark:hover:bg-red-900/40 dark:text-red-400 rounded-lg text-sm font-medium transition-colors border border-red-200 dark:border-red-800 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <span className="material-icons-round text-sm">logout</span>
                                    {isLoggingOut ? "Logging out..." : "Logout WhatsApp Session"}
                                </button>
                            </div>
                        )}
                    </div>
                </section>
            </div>

            {/* Prayer Management Section */}
            <section className="mt-8 bg-white dark:bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                    <span className="material-icons-round text-primary">list_alt</span>
                    Prayer Requests ({prayers.length})
                </h2>

                {prayers.length === 0 ? (
                    <p className="text-slate-500 italic text-center py-8">No prayer requests found.</p>
                ) : (
                    <div className="flex flex-col gap-4">
                        {prayers.map((prayer) => (
                            <div key={prayer.id} className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-between items-start gap-4">
                                <div className="flex-1">
                                    <p className="text-sm text-slate-500 mb-1">
                                        {new Date(prayer.createdAt).toLocaleString()}
                                    </p>
                                    <p className="whitespace-pre-wrap text-slate-800 dark:text-slate-200">{prayer.content}</p>
                                </div>
                                <button
                                    onClick={() => deletePrayer(prayer.id)}
                                    className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors flex items-center gap-1"
                                    title="Delete Prayer"
                                >
                                    <span className="material-icons-round">delete</span>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </main>
    );
}
