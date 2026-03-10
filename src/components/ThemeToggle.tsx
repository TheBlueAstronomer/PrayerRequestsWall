"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

/* ── animation config ── */
const ANIM = {
    /* spring presets */
    spring:      { type: "spring" as const, stiffness: 400, damping: 32 },
    slowSpring:  { type: "spring" as const, stiffness: 160, damping: 22 },
    /* reduced-motion fallbacks */
    instant:     { duration: 0 },
    fast:        { duration: 0.1 },
    fade:        { duration: 0.15 },
    /* star entrance */
    starBaseDelay: 0.22,
    starStagger:   0.12,
    /* scene */
    skyDuration:   0.3,
    cloud2Delay:   0.07,
    starExitDur:   0.25,
};

/* ── pill dimensions ── */
const W   = 72;
const H   = 34;
const KR  = 13;
const KOF = 4;

/* ── star data: pixel coords within W×H viewBox ── */
const STARS = [
    { id: 1, x: 10, y: 8,  r: 2.6, stagger: 0, twinkDur: 2.0 },
    { id: 2, x: 24, y: 22, r: 1.8, stagger: 2, twinkDur: 2.4 },
    { id: 3, x: 6,  y: 26, r: 3.2, stagger: 4, twinkDur: 1.8 },
    { id: 4, x: 34, y: 6,  r: 1.5, stagger: 1, twinkDur: 2.6 },
    { id: 5, x: 42, y: 28, r: 2.0, stagger: 5, twinkDur: 2.1 },
    { id: 6, x: 18, y: 30, r: 1.4, stagger: 3, twinkDur: 1.9 },
    { id: 7, x: 30, y: 14, r: 1.3, stagger: 6, twinkDur: 2.3 },
];

function starPoly(r: number): string {
    const inner = r * 0.4;
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const rad = i % 2 === 0 ? r : inner;
        pts.push(`${(rad * Math.cos(a)).toFixed(2)},${(rad * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(" ");
}

export function ThemeToggle() {
    const { theme, setTheme, systemTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const prefersReducedMotion = useReducedMotion();

    useEffect(() => {
        const frame = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    /* Skeleton placeholder — same footprint so layout doesn't shift */
    if (!mounted) {
        return (
            <div
                className="fixed top-0 right-4 md:right-8 z-50 flex items-center"
                style={{ height: 64 }}
            >
                <div
                    className="rounded-full bg-slate-300/30 dark:bg-slate-700/30"
                    style={{ width: W, height: H }}
                />
            </div>
        );
    }

    const currentTheme = theme === "system" ? systemTheme : theme;
    const isDark = currentTheme === "dark";

    /* Dark: matches app bg-background-dark (#101d22) + primary teal glow */
    /* Light: sky blue */
    const trackBg   = isDark ? "#0d1c22" : "#6eb3e8";
    const trackGlow = isDark
        ? "0 2px 16px rgba(19,182,236,0.18), inset 0 1px 0 rgba(255,255,255,0.05)"
        : "0 2px 16px rgba(100,160,220,0.35), inset 0 1px 0 rgba(255,255,255,0.35)";

    const knobX = isDark ? W - KR * 2 - KOF : KOF;

    const trackTrans  = prefersReducedMotion ? ANIM.fade    : ANIM.slowSpring;
    const knobTrans   = prefersReducedMotion ? ANIM.instant  : ANIM.spring;
    const popTrans    = prefersReducedMotion ? ANIM.fast     : ANIM.spring;
    const cloudTrans  = prefersReducedMotion ? ANIM.fade     : ANIM.slowSpring;
    const cloud2Trans = prefersReducedMotion ? ANIM.fade     : { ...ANIM.slowSpring, delay: ANIM.cloud2Delay };

    return (
        <>
            <motion.button
                onClick={() => setTheme(isDark ? "light" : "dark")}
                aria-label="Toggle theme"
                /* ── positioning: fixed strip flush with the top nav bar (h-16 = 64px) ── */
                className="fixed top-0 right-4 md:right-8 z-50 flex items-center cursor-pointer select-none"
                style={{ height: 64, WebkitTapHighlightColor: "transparent" }}
                whileTap={{ scale: 0.94 }}
            >
                {/* ── Pill track ── */}
                <motion.div
                    className="relative overflow-hidden rounded-full"
                    style={{ width: W, height: H }}
                    animate={{ backgroundColor: trackBg, boxShadow: trackGlow }}
                    transition={trackTrans}
                >
                    {/* ── LIGHT SCENE: sky arc + clouds ── */}
                    <AnimatePresence>
                        {!isDark && (
                            <>
                                <motion.div
                                    key="sky"
                                    className="absolute rounded-full"
                                    style={{
                                        width: 90, height: 90,
                                        top: -40, left: -8,
                                        background: "radial-gradient(circle at 40% 65%, #5aaee8 0%, #88ccf5 70%, #c8e8fb 100%)",
                                    }}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={prefersReducedMotion ? ANIM.fade : { duration: ANIM.skyDuration }}
                                />
                                {/* Cloud right-foreground */}
                                <motion.div
                                    key="cl1"
                                    className="absolute"
                                    style={{ bottom: -5, right: -2 }}
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: 20, opacity: 0 }}
                                    transition={cloudTrans}
                                >
                                    <svg width="46" height="30" viewBox="0 0 46 30" fill="none">
                                        <ellipse cx="28" cy="22" rx="17" ry="10" fill="white" fillOpacity="0.95" />
                                        <ellipse cx="18" cy="24" rx="12" ry="8"  fill="white" />
                                        <ellipse cx="36" cy="18" rx="11" ry="9"  fill="white" fillOpacity="0.9" />
                                    </svg>
                                </motion.div>
                                {/* Cloud left-mid */}
                                <motion.div
                                    key="cl2"
                                    className="absolute"
                                    style={{ bottom: 0, left: 10 }}
                                    initial={{ x: -14, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -14, opacity: 0 }}
                                    transition={cloud2Trans}
                                >
                                    <svg width="32" height="18" viewBox="0 0 32 18" fill="none">
                                        <ellipse cx="18" cy="13" rx="13" ry="7" fill="white" fillOpacity="0.6" />
                                        <ellipse cx="10" cy="15" rx="9"  ry="5" fill="white" fillOpacity="0.5" />
                                        <ellipse cx="24" cy="10" rx="8"  ry="7" fill="white" fillOpacity="0.55" />
                                    </svg>
                                </motion.div>
                            </>
                        )}
                    </AnimatePresence>

                    {/* ── DARK SCENE: twinkling stars ── */}
                    <AnimatePresence>
                        {isDark && (
                            <motion.svg
                                key="stars"
                                data-testid="stars-svg"
                                className="absolute inset-0"
                                width={W}
                                height={H}
                                viewBox={`0 0 ${W} ${H}`}
                                initial={{ opacity: 1 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: ANIM.starExitDur }}
                            >
                                {STARS.map((s) => {
                                    const delay = ANIM.starBaseDelay + s.stagger * ANIM.starStagger;
                                    return (
                                        <motion.g
                                            key={s.id}
                                            initial={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.3 }}
                                            animate={prefersReducedMotion
                                                ? { opacity: 1, scale: 1 }
                                                : {
                                                    opacity: [0, 1, 0.65, 1, 0.5, 1],
                                                    scale:   [0.3, 1.2, 0.9, 1.05, 0.9, 1.0],
                                                }
                                            }
                                            transition={prefersReducedMotion
                                                ? { delay, duration: 0.15 }
                                                : {
                                                    delay,
                                                    duration: s.twinkDur * 1.8,
                                                    times: [0, 0.1, 0.25, 0.45, 0.7, 1],
                                                    repeat: Infinity,
                                                    repeatType: "mirror",
                                                    ease: "easeInOut",
                                                }
                                            }
                                            style={{ transformOrigin: `${s.x}px ${s.y}px` }}
                                        >
                                            <polygon
                                                points={starPoly(s.r)}
                                                fill="white"
                                                transform={`translate(${s.x},${s.y})`}
                                            />
                                        </motion.g>
                                    );
                                })}
                            </motion.svg>
                        )}
                    </AnimatePresence>

                    {/* ── Knob ── */}
                    <motion.div
                        className="absolute"
                        style={{ top: H / 2 - KR, width: KR * 2, height: KR * 2 }}
                        animate={{ x: knobX }}
                        transition={knobTrans}
                    >
                        <div
                            className="w-full h-full rounded-full relative overflow-hidden"
                            style={{
                                boxShadow: isDark
                                    ? "0 1px 8px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.12)"
                                    : "0 2px 8px rgba(180,110,0,0.4), inset 0 1px 0 rgba(255,255,255,0.5)",
                            }}
                        >
                            {/* Sun */}
                            <AnimatePresence>
                                {!isDark && (
                                    <motion.div
                                        key="sun"
                                        className="absolute inset-0 rounded-full"
                                        style={{ background: "radial-gradient(circle at 36% 34%, #ffe066 0%, #f4a018 58%, #e8850c 100%)" }}
                                        initial={{ scale: prefersReducedMotion ? 1 : 0.5, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ scale: prefersReducedMotion ? 1 : 0.4, opacity: 0 }}
                                        transition={popTrans}
                                    />
                                )}
                            </AnimatePresence>

                            {/* Moon */}
                            <AnimatePresence>
                                {isDark && (
                                    <motion.div
                                        key="moon"
                                        className="absolute inset-0 rounded-full"
                                        style={{ background: "radial-gradient(circle at 36% 34%, #d8d8d8 0%, #b2b2b2 52%, #909090 100%)" }}
                                        initial={{ scale: prefersReducedMotion ? 1 : 0.5, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ scale: prefersReducedMotion ? 1 : 0.4, opacity: 0 }}
                                        transition={popTrans}
                                    >
                                        <div className="absolute rounded-full" style={{ width: 7,  height: 7,  top: 5,  left: 7,  background: "#7a7a7a", opacity: 0.55 }} />
                                        <div className="absolute rounded-full" style={{ width: 5,  height: 5,  top: 14, left: 12, background: "#7a7a7a", opacity: 0.45 }} />
                                        <div className="absolute rounded-full" style={{ width: 4,  height: 4,  top: 8,  left: 16, background: "#7a7a7a", opacity: 0.40 }} />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </motion.div>

                    {/* Inset shadow for depth */}
                    <div
                        className="absolute inset-0 rounded-full pointer-events-none"
                        style={{ boxShadow: "inset 0 1px 4px rgba(0,0,0,0.22)" }}
                    />
                </motion.div>
            </motion.button>
        </>
    );
}
