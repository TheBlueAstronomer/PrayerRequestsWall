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
        <main className="flex-1 flex flex-col px-6 max-w-md md:max-w-3xl lg:max-w-4xl mx-auto w-full relative z-10 md:pt-10">
            <div className="h-12 w-full md:hidden"></div>

            <header className="pt-8 md:pt-16 pb-10 text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 md:w-20 md:h-20 rounded-full bg-primary/10 dark:bg-primary/20 mb-6">
                    <span className="material-icons-round text-primary text-3xl md:text-4xl">favorite</span>
                </div>
                <h1 className="text-3xl md:text-5xl font-bold tracking-tight mb-2 md:mb-4">You are not alone.</h1>
                <p className="text-slate-500 dark:text-slate-400 text-sm md:text-lg font-light">
                    Share your heart. Your request is <span className="text-primary/80 font-medium">completely anonymous</span>.
                </p>
            </header>

            <section className="flex-1 flex flex-col">
                {status === "success" ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-in">
                        <div className="w-20 h-20 md:w-24 md:h-24 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-6">
                            <span className="material-icons-round text-green-600 dark:text-green-400 text-4xl md:text-5xl">check</span>
                        </div>
                        <h3 className="text-xl md:text-3xl font-bold mb-2">Prayer Request Sent</h3>
                        <p className="text-slate-500 text-sm md:text-base mb-8">Your request has been shared anonymously.</p>
                        <button
                            onClick={() => setStatus("idle")}
                            className="text-primary font-medium hover:underline"
                        >
                            Send another request
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="relative group shadow-sm md:shadow-md rounded-xl">
                            <textarea
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                className="w-full h-48 md:h-80 p-5 md:p-8 rounded-xl bg-white dark:bg-primary/5 border border-slate-200 dark:border-primary/20 focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-300 resize-none text-lg md:text-2xl leading-relaxed dark:placeholder-slate-600 outline-none"
                                maxLength={maxLength}
                                placeholder="Type your prayer here..."
                                disabled={isSubmitting}
                            ></textarea>
                            <div className="absolute bottom-4 right-4 md:bottom-6 md:right-8 flex items-center gap-2 bg-white/80 dark:bg-black/50 ios-blur px-2 py-1 rounded-md pointer-events-none">
                                <span className="text-xs md:text-sm font-medium text-slate-400 dark:text-slate-500">
                                    {message.length} / {maxLength}
                                </span>
                            </div>
                        </div>

                        <div className="mt-4 md:mt-6 flex items-center justify-center gap-2 text-[10px] md:text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500 font-bold">
                            <span className="material-icons-round text-xs md:text-sm">lock</span>
                            100% Anonymous & Private
                        </div>

                        {status === "error" && (
                            <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg text-center">
                                Something went wrong. Please try again.
                            </div>
                        )}

                        <div className="mt-auto pt-4 pb-32 md:pb-16 flex flex-col gap-4 max-w-sm mx-auto w-full">
                            <button
                                onClick={handleSubmit}
                                disabled={!message.trim() || isSubmitting}
                                className="w-full bg-primary hover:bg-primary/90 text-white font-semibold py-4 md:py-5 md:text-lg rounded-xl shadow-lg shadow-primary/25 transition-transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                            >
                                {isSubmitting ? (
                                    <>
                                        <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
                                        Sending...
                                    </>
                                ) : (
                                    <>
                                        Send Prayer Request
                                        <span className="material-icons-round text-sm md:text-base">send</span>
                                    </>
                                )}
                            </button>
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

            {/* Mobile Bottom / Desktop Top Navigation */}
            <nav className="fixed bottom-0 md:top-0 md:bottom-auto left-0 right-0 pb-8 md:pb-0 pt-2 md:pt-0 px-6 md:px-8 border-t md:border-t-0 md:border-b border-slate-100 dark:border-slate-800/50 ios-blur bg-white/80 dark:bg-background-dark/80 z-40 transition-colors">
                <div className="flex justify-around md:justify-start md:gap-8 items-center max-w-md md:max-w-4xl mx-auto md:h-16">
                    <div className="flex flex-col md:flex-row items-center gap-1 md:gap-2 text-primary flex-1 md:flex-none cursor-pointer">
                        <span className="material-icons-round text-base md:text-xl">add_circle</span>
                        <span className="text-[10px] md:text-sm font-medium">Request</span>
                    </div>
                    <Link href="/wall" className="flex flex-col md:flex-row items-center gap-1 md:gap-2 text-slate-400 dark:text-slate-500 flex-1 md:flex-none hover:text-primary dark:hover:text-primary transition-colors">
                        <span className="material-icons-round text-base md:text-xl">diversity_3</span>
                        <span className="text-[10px] md:text-sm font-medium">Wall</span>
                    </Link>
                </div>
                <div className="w-32 h-1 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-6 opacity-30 md:hidden"></div>
            </nav>
        </main>
    );
}
