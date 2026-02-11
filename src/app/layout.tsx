import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google"; // Changed from Geist to match mockups
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta-sans", // We can use this or just set it globally in CSS as we did
});

export const metadata: Metadata = {
  title: "Submit a Prayer Request",
  description: "Share your heart. Your request is completely anonymous.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons+Round" rel="stylesheet" />
      </head>
      <body
        suppressHydrationWarning
        className={`${plusJakartaSans.className} antialiased bg-background-light dark:bg-background-dark text-slate-900 dark:text-slate-100`}
      >
        {children}
      </body>
    </html>
  );
}
