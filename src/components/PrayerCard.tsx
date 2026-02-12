'use client';

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

interface PrayerRequest {
    id: number;
    content: string;
    createdAt: string | Date;
}

export function PrayerCard({ request, index }: { request: PrayerRequest; index: number }) {
    const [timeAgo, setTimeAgo] = useState('');
    const [isNew, setIsNew] = useState(false);

    useEffect(() => {
        const date = new Date(request.createdAt);
        const now = new Date();
        const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

        if (diffInSeconds < 60) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTimeAgo('Just now');
            setIsNew(true);
        } else if (diffInSeconds < 3600) {
            const minutes = Math.floor(diffInSeconds / 60);
            setTimeAgo(`${minutes} minute${minutes > 1 ? 's' : ''} ago`);
            setIsNew(true); // Consider new if < 1 hour
        } else if (diffInSeconds < 86400) {
            const hours = Math.floor(diffInSeconds / 3600);
            setTimeAgo(`${hours} hour${hours > 1 ? 's' : ''} ago`);
            setIsNew(false);
        } else {
            const days = Math.floor(diffInSeconds / 86400);
            if (days === 1) setTimeAgo('Yesterday');
            else setTimeAgo(`${days} days ago`);
            setIsNew(false);
        }
    }, [request.createdAt]);

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1, duration: 0.5 }}
            className="bg-white dark:bg-slate-900/40 p-5 rounded-xl border border-slate-200 dark:border-slate-800/50 shadow-sm"
        >
            <div className="flex justify-between items-start mb-3">
                {isNew ? (
                    <span className="text-[10px] font-bold tracking-widest uppercase text-primary bg-primary/10 px-2 py-1 rounded-full">New</span>
                ) : (
                    <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-700 mt-1"></div>
                )}
                <span className="text-xs text-slate-400 dark:text-slate-500">{timeAgo}</span>
            </div>

            <p className="text-[15px] leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
                {request.content}
            </p>

            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800/50 flex items-center justify-end">
                <span className="material-icons-round text-slate-300 dark:text-slate-700 cursor-pointer text-lg">more_horiz</span>
            </div>
        </motion.div>
    );
}
