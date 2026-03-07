# Prayer Requests Wall (Project Intercessor)

Project Intercessor is a digital safe haven for youth group members to share prayer requests anonymously. It serves three main functions:
1.  **Instant Broadcast:** Forwards prayer requests instantly to designated WhatsApp groups via a bot.
2.  **Public Prayer Wall:** Maintains a persistent, public "Prayer Wall" for members to view and pray for past requests.
3.  **Admin Management:** A secure dashboard to manage the WhatsApp bot, configure group IDs, and moderate prayer requests.

## Features

-   **100% Anonymity:** No IP logging, user tracking, or login required for members.
-   **Real-time WhatsApp Integration:** Automatically posts new requests to one or more WhatsApp groups.
-   **Admin Dashboard:** 
    -   Secure login with password protection.
    -   Live WhatsApp QR code for easy bot authentication.
    -   Dynamic configuration of target WhatsApp Group/Chat IDs.
    -   Prayer request moderation (view and delete entries).
-   **Public Prayer Wall:** A beautiful, read-only feed of all submitted requests.
-   **Modern UI:** "Sanctuary" theme with glassmorphism effects and smooth animations using Framer Motion.
-   **Automated Deployment:** Integrated CI/CD pipeline for Google Cloud Platform.

## Tech Stack

-   **Framework:** [Next.js 15](https://nextjs.org/) (App Router)
-   **Language:** [TypeScript](https://www.typescriptlang.org/)
-   **Library:** [React 19](https://react.dev/)
-   **Styling:** [Tailwind CSS 4](https://tailwindcss.com/)
-   **Animations:** [Framer Motion](https://www.framer.com/motion/)
-   **Database:** [SQLite](https://www.sqlite.org/) with [Drizzle ORM](https://orm.drizzle.team/)
-   **WhatsApp:** [whatsapp-web.js](https://wwebjs.dev/)

## Getting Started

### Prerequisites

-   Node.js 20+ installed.
-   [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Recommended for easiest setup).

### Installation

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd PrayerRequestsWall
    ```

2.  Create your `.env` file from the provided environment variables:
    ```bash
    # Create and edit .env with your credentials
    # Required: ADMIN_PASSWORD, etc.
    ```

3.  Create local data directory (Required for Docker persistence):
    ```bash
    mkdir data
    ```

### Running Locally (Docker - Recommended)

The project is containerized, matching the production environment.

1.  Start the application:
    ```bash
    docker-compose up
    ```
2.  Open [http://localhost](http://localhost).
3.  **Admin & WhatsApp Auth**: 
    -   Go to [http://localhost/admin](http://localhost/admin).
    -   Log in with your `ADMIN_PASSWORD`.
    -   Scan the QR code displayed on the dashboard with your WhatsApp mobile app.

### Running Locally (Development Mode)

#### 1. Standard Development (Frontend Only)
Use this if you only need to work on the UI. WhatsApp functionality will be disabled.
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

#### 2. Full Application (with WhatsApp Bot)
To run the full application including the custom server:
```bash
npm run dev:custom
```
Watch the terminal for the QR code or use the Admin Dashboard at `/admin`.

## Scripts

-   `npm run dev`: Starts the Next.js dev server (no WhatsApp bot).
-   `npm run dev:custom`: Starts the custom server (Next.js + WhatsApp bot) using `tsx`.
-   `npm run build`: Builds the application for production.
-   `npm run start`: Starts the production server (custom server mode).
-   `npm run db:push`: Pushes schema changes to the SQLite database.
-   `npm run db:studio`: Opens Drizzle Studio to manage database content.

## Project Structure

-   `/src/app`: Next.js App Router (Home, Wall, Admin Dashboard).
-   `/src/app/api`: Backend API routes for submission, admin auth, and settings.
-   `/src/components`: Premium UI components with Framer Motion animations.
-   `/src/lib`: Core logic (WhatsApp service, database client).
-   `/server.ts`: Custom Node.js entry point coordinating Next.js and the WhatsApp bot.
-   `cloudbuild.yaml`: Automated build and deploy configuration for GCP.

## Deployment

This project uses a **fully automated CI/CD pipeline** targeting Google Cloud Platform (Compute Engine + Artifact Registry). 

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for detailed instructions on setting up the infrastructure and the automated workflow.
