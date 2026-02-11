import { db } from '@/db';
import { prayerRequests } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { PrayerCard } from '@/components/PrayerCard';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function PrayerWall() {
    const requests = await db.select().from(prayerRequests).orderBy(desc(prayerRequests.createdAt));

    return (
        <main className="min-h-screen flex justify-center bg-black/5 dark:bg-black/20">
            <div className="w-full max-w-[480px] h-[100dvh] bg-background-light dark:bg-background-dark relative shadow-2xl flex flex-col border-x border-slate-200 dark:border-slate-800/50 overflow-hidden">

                {/* Status Bar Spacer (optional, mockup has it but we can skip or simulate) */}
                {/* <div className="h-12 w-full bg-background-light/80 dark:bg-background-dark/80 backdrop-blur-md sticky top-0 z-50 px-6 flex items-center justify-between pointer-events-none"></div> */}

                {/* Header */}
                <header className="px-6 py-4 bg-background-light/80 dark:bg-background-dark/80 backdrop-blur-md sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800/50 shrink-0">
                    <div className="flex justify-between items-end">
                        <div>
                            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Prayer Wall</h1>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">A safe space for your heart</p>
                        </div>
                        {/* Refresh Button - purely visual or link to self */}
                        <a href="/wall" className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary transition hover:bg-primary/20">
                            <span className="material-icons-round">refresh</span>
                        </a>
                    </div>
                </header>

                {/* Scrollable Content */}
                <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4 scroll-smooth">
                    {requests.map((req, i) => (
                        <PrayerCard
                            key={req.id}
                            request={{ ...req, createdAt: req.createdAt.toISOString() }}
                            index={i}
                        />
                    ))}
                    {requests.length === 0 && (
                        <div className="text-center text-slate-400 py-10">
                            No requests yet. Be the first to share.
                        </div>
                    )}
                    <div className="h-24"></div> {/* Spacer for FAB/Nav */}
                </div>

                {/* FAB */}
                <Link href="/" className="absolute bottom-24 right-6 w-14 h-14 bg-primary text-white rounded-full shadow-lg shadow-primary/30 flex items-center justify-center z-50 hover:bg-sky-500 transition-colors">
                    <span className="material-icons-round text-3xl">add</span>
                </Link>

                {/* Bottom Nav */}
                <nav className="w-full h-20 bg-background-light/90 dark:bg-background-dark/90 backdrop-blur-md border-t border-slate-200 dark:border-slate-800/50 flex items-center justify-center pb-4 z-40 shrink-0 relative">
                    <button className="flex flex-col items-center space-y-1 text-primary">
                        <span className="material-icons-round text-2xl">grid_view</span>
                        <span className="text-[10px] font-bold uppercase tracking-wider">The Wall</span>
                    </button>
                    {/* Decorative indicator */}
                    <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-32 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full"></div>
                </nav>
            </div>
        </main>
    );
}
