# Prayer Requests Wall (Project Intercessor)

Project Intercessor is a digital safe haven for youth group members to share prayer requests anonymously. It serves two main functions:
1.  **Instant Broadcast:** Forwards prayer requests instantly to a designated WhatsApp group via a bot.
2.  **Public Prayer Wall:** Maintains a persistent, public "Prayer Wall" for members to view and pray for past requests.

## Features

-   **100% Anonymity:** No IP logging, user tracking, or login required.
-   **Real-time WhatsApp Integration:** Automatically posts new requests to a WhatsApp group.
-   **Public Prayer Wall:** A read-only feed of all submitted requests.
-   **Modern UI:** "Sanctuary" theme with glassmorphism effects and smooth animations using Framer Motion.
-   **Lightweight:** Built to run on minimal infrastructure (AWS Free Tier).

## Use Cases

-   **The Member:** Can submit a prayer request without social anxiety and see it acknowledged immediately.
-   **The Leader/Community:** Receives requests instantly in their WhatsApp group to respond with prayer.

## Tech Stack

-   **Framework:** [Next.js](https://nextjs.org/) (App Router)
-   **Language:** [TypeScript](https://www.typescriptlang.org/)
-   **Styling:** [Tailwind CSS](https://tailwindcss.com/)
-   **Animations:** [Framer Motion](https://www.framer.com/motion/)
-   **Database:** [SQLite](https://www.sqlite.org/) with [Drizzle ORM](https://orm.drizzle.team/)
-   **WhatsApp:** [whatsapp-web.js](https://wwebjs.dev/)

## Getting Started

### Prerequisites

-   Node.js 20+ installed.

### Installation

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd PrayerRequestsWall
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Set up the database:
    ```bash
    npm run db:push
    ```

### Running the Application

This project supports two modes of operation:

#### 1. Standard Development (Frontend Only)
Run the standard Next.js development server if you only need to work on the UI pages (Submission Form, Prayer Wall). Note that WhatsApp functionality *will not work* in this mode.

```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

#### 2. Full Application (with WhatsApp Bot)
To run the full application including the custom server for WhatsApp integration:

```bash
npm run dev:custom
```

**First Run Instructions:**
-   When you run `npm run dev:custom` for the first time, a QR code will be generated in your terminal.
-   Scan this QR code with the WhatsApp account you want to use as the "Bot".
-   Once authenticated, the session will be saved locally in `.wwebjs_auth`.

## scripts

-   `npm run dev`: Starts the Next.js dev server (no custom server).
-   `npm run dev:custom`: Starts the custom server with `nodemon` (Next.js + WhatsApp).
-   `npm run build`: Builds the Next.js application for production.
-   `npm run start`: Starts the production Next.js server.
-   `npm run lint`: Runs ESLint.
-   `npm run db:push`: Pushes schema changes to the SQLite database.
-   `npm run db:studio`: Opens Drizzle Studio to view/edit database content.

## Project Structure

-   `/src/app`: Next.js App Router pages and layouts.
-   `/src/components`: Reusable UI components.
-   `/src/lib`: Utility functions (including WhatsApp client logic).
-   `/server.ts`: Custom Node.js server entry point for coordinating Next.js and whatsapp-web.js.
-   `drizzle.config.ts`: Configuration for Drizzle ORM.
-   `PRD.md`: Detailed Product Requirements Document.

## Deployment Notes

For deployment (e.g., on AWS EC2):
1.  Ensure you have a swap file enabled (recommended 2GB) as Puppeteer/Chrome can be memory intensive.
2.  Use a process manager like PM2 to keep the `server.ts` process alive.
