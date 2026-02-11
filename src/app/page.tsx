"use client";

import { useState } from "react";
import Link from "next/link";

export default function SubmitPage() {
    const [message, setMessage] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
    const maxLength = 1000;

    const handleSubmit = async () => {
        if (!message.trim()) return;

        setIsSubmitting(true);
        setStatus("idle");

        try {
            const response = await fetch("/api/submit", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ message }),
            });

            if (response.ok) {
                setStatus("success");
                setMessage("");
            } else {
                setStatus("error");
            }
        } catch (error) {
            console.error("Error submitting prayer request:", error);
            setStatus("error");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <main className="flex-1 flex flex-col px-6 max-w-md mx-auto w-full relative z-10">
            <div className="h-12 w-full"></div>

            <header className="pt-8 pb-10 text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 dark:bg-primary/20 mb-6">
                    <span className="material-icons-round text-primary text-3xl">favorite</span>
                </div>
                <h1 className="text-3xl font-bold tracking-tight mb-2">You are not alone.</h1>
                <p className="text-slate-500 dark:text-slate-400 text-sm font-light">
                    Share your heart. Your request is <span className="text-primary/80 font-medium">completely anonymous</span>.
                </p>
            </header>

            <section className="flex-1 flex flex-col">
                {status === "success" ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-in">
                        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-6">
                            <span className="material-icons-round text-green-600 dark:text-green-400 text-4xl">check</span>
                        </div>
                        <h3 className="text-xl font-bold mb-2">Prayer Request Sent</h3>
                        <p className="text-slate-500 text-sm mb-8">Your request has been shared anonymously.</p>
                        <button
                            onClick={() => setStatus("idle")}
                            className="text-primary font-medium hover:underline"
                        >
                            Send another request
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="relative group">
                            <textarea
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                className="w-full h-64 p-5 rounded-xl bg-white dark:bg-primary/5 border border-slate-200 dark:border-primary/20 focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-300 resize-none text-lg leading-relaxed dark:placeholder-slate-600 outline-none"
                                maxLength={maxLength}
                                placeholder="Type your prayer here..."
                                disabled={isSubmitting}
                            ></textarea>
                            <div className="absolute bottom-4 right-4 flex items-center gap-2">
                                <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
                                    {message.length} / {maxLength}
                                </span>
                            </div>
                        </div>

                        <div className="mt-4 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 font-bold">
                            <span className="material-icons-round text-xs">lock</span>
                            100% Anonymous & Private
                        </div>

                        {status === "error" && (
                            <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg text-center">
                                Something went wrong. Please try again.
                            </div>
                        )}

                        <div className="mt-auto pt-8 pb-12 flex flex-col gap-4">
                            <button
                                onClick={handleSubmit}
                                disabled={!message.trim() || isSubmitting}
                                className="w-full bg-primary hover:bg-primary/90 text-white font-semibold py-4 rounded-xl shadow-lg shadow-primary/25 transition-transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                            >
                                {isSubmitting ? (
                                    <>
                                        <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
                                        Sending...
                                    </>
                                ) : (
                                    <>
                                        Send Prayer Request
                                        <span className="material-icons-round text-sm">send</span>
                                    </>
                                )}
                            </button>

                            <Link href="/wall" className="w-full bg-transparent hover:bg-primary/10 text-primary font-medium py-3 rounded-xl transition-colors text-sm text-center block">
                                View Prayer Wall
                            </Link>
                        </div>
                    </>
                )}
            </section>

            {/* Background Image Overlay */}
            <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden opacity-20 dark:opacity-10">
                <img
                    alt=""
                    className="absolute top-0 left-0 w-full h-full object-cover mix-blend-overlay"
                    src="https://lh3.googleusercontent.com/aida-public/AB6AXuBbkAXpha-a97X8kD94Zp-Gti0TlAtr5v5kynUmCSjlsmR7r_TTTrfuXA5XJssR3Ns8yPoUG3DnREzjMekHWN8vJwhfdKHG-hzELi-vz7o-5MQrP_0avgJoMFaU6Ui45dulxbkRbV1vY5wQdMS6OEuLWcIHjI3bTHD91sNWRClDgOPuXs8TFkWXu7x-jjPMsgZEdFuzuvn6yiPwG8tcMs-hqIx5MRA_IVB71lMuKRMZ_Rs6JI3sfM6B9JRrbek1KUhOYDGsLnSDknU"
                />
            </div>

            {/* Bottom Navigation */}
            <nav className="fixed bottom-0 left-0 right-0 pb-8 pt-2 px-6 border-t border-slate-100 dark:border-primary/10 ios-blur bg-white/80 dark:bg-background-dark/80 z-50">
                <div className="flex justify-around items-center max-w-md mx-auto">
                    <div className="flex flex-col items-center gap-1 text-primary flex-1 cursor-pointer">
                        <span className="material-icons-round">add_circle</span>
                        <span className="text-[10px] font-medium">Request</span>
                    </div>
                    <Link href="/wall" className="flex flex-col items-center gap-1 text-slate-400 dark:text-slate-600 flex-1 hover:text-primary transition-colors">
                        <span className="material-icons-round">diversity_3</span>
                        <span className="text-[10px] font-medium">Wall</span>
                    </Link>
                </div>
                <div className="w-32 h-1 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-6 opacity-30"></div>
            </nav>
        </main>
    );
}
