# Deploying Prayer Requests Wall to Google Cloud (Free Tier)

This guide covers how to deploy the "Prayer Requests Wall" application to a Google Cloud Platform (GCP) **e2-micro** instance, which is part of the [GCP Free Tier](https://cloud.google.com/free).

Because this application requires a persistent connection for WhatsApp (via Puppeteer/Chrome), we cannot use serverless platforms like Vercel or Cloud Run easily. A Virtual Machine (VM) is the best choice.

## Prerequisites

1.  A Google Cloud Platform Account.
2.  A project created in the Google Cloud Console.
3.  Basic familiarity with the terminal.

---

## Step 1: Create the VM Instance

1.  Navigate to **Compute Engine** > **VM instances** in the Google Cloud Console.
2.  Click **Create Instance**.
3.  **Name:** `prayer-wall-server` (or any name you prefer).
4.  **Region:** Choose a Free Tier eligible region (usually `us-central1`, `us-west1`, or `us-east1`).
5.  **Machine Configuration:**
    -   Series: **E2**
    -   Machine type: **e2-micro** (2 vCPU, 1 GB memory).
6.  **Boot Disk:**
    -   Click **Change**.
    -   Operating System: **Ubuntu**
    -   Version: **Ubuntu 22.04 LTS** (or 24.04 LTS)
    -   Boot disk type: **Standard persistent disk** (up to 30GB is free). Set it to **20GB** to be safe.
7.  **Firewall:**
    -   Check **Allow HTTP traffic**.
    -   Check **Allow HTTPS traffic**.
8.  Click **Create**.

---

## Step 2: Configure the Server

Once the instance is running, click the **SSH** button next to it to open a terminal.

### 2.1. Update System & Install Dependencies
Run the following commands to update the system and install necessary tools:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git unzip build-essential
```

### 2.2. Create a Swap File (CRITICAL)
The `e2-micro` instance only has 1GB of RAM. Puppeteer (Chrome) can eat this up quickly. We MUST create a swap file to prevent crashes.

```bash
# Create a 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make it permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.3. Install Node.js (via NVM)
We need Node.js 20+.

```bash
# Install NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Activate NVM (or restart terminal)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node 20
nvm install 20
nvm use 20
nvm alias default 20

# Install PM2 (Process Manager)
npm install -g pm2
```

### 2.4. Install Chrome Dependencies for Puppeteer
Puppeteer needs certain system libraries to run headless Chrome.

```bash
# For Ubuntu 22.04 LTS (Standard):
sudo apt install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils

# For Ubuntu 24.04 LTS (Newer, handles t64 package renaming):
sudo apt install -y ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libc6 libcairo2 libcups2t64 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
```

---

## Step 3: Deploy the Application

### 3.1. Clone the Repository
Replace `<YOUR_REPO_URL>` with your actual GitHub repository URL.

```bash
git clone <YOUR_REPO_URL>
cd PrayerRequestsWall
```

### 3.2. Install Dependencies & Build
```bash
npm install
npm run build
```

### 3.3. Database Setup (SQLite)
Since we are using SQLite, the database is a file.
Initialize the database:
```bash
npm run db:push
```

### 3.4. Start with PM2
We use PM2 to keep the app running in the background.

```bash
# Start the app using the 'start' script which runs 'tsx server.ts'
pm2 start npm --name "prayer-wall" -- run start
```

### 3.5. WhatsApp Authentication (First Run)
To authenticate WhatsApp, we need to see the QR code. PM2 logs will show it, but it might be messy. The easiest way for the **first run** is to stop PM2, run manually, authenticate, then restart PM2.

```bash
# Stop PM2 temporarily
pm2 stop prayer-wall

# Run manually to scan QR code
npm run start
```
**Scan the QR code** with your phone. Once you see "Ready on http://localhost:3000" and "Client is ready!", press `Ctrl+C` to stop it. The session is now saved in `.wwebjs_auth`.

```bash
# Restart PM2
pm2 restart prayer-wall
```

---

## Step 4: Configure Nginx (Reverse Proxy)

By default, the app runs on port 3000. We want it accessible via port 80 (HTTP).

1.  **Install Nginx:**
    ```bash
    sudo apt install -y nginx
    ```

2.  **Configure Nginx:**
    Create a configuration file for your app.
    ```bash
    sudo nano /etc/nginx/sites-available/prayer-wall
    ```

    Paste the following. (Note: `server_name _;` is a wildcard that allows access via the VM's IP. If you have a domain, you can replace `_` with it).

    ```nginx
    server {
        listen 80;
        server_name _;  # Or your domain name

        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }
    }
    ```

3.  **Enable the Site:**
    ```bash
    sudo ln -s /etc/nginx/sites-available/prayer-wall /etc/nginx/sites-enabled/
    sudo rm /etc/nginx/sites-enabled/default  # Remove default welcome page
    sudo nginx -t  # Test configuration
    sudo systemctl restart nginx
    ```

## Done!
Access your application via the VM's External IP address (found in Google Cloud Console).

---

## Maintenance

-   **View Logs:** `pm2 logs prayer-wall`
-   **Restart App:** `pm2 restart prayer-wall`
-   **Update App:**
    ```bash
    cd PrayerRequestsWall
    git pull
    npm install
    npm run build
    pm2 restart prayer-wall
    ```

---

## Continuous Deployment (CI/CD)

We have set up a GitHub Actions workflow that automatically deploys changes to your server whenever you push to the `master` branch.

### 1. Generate an SSH Key Pair

On your local machine (not the server), generate a new SSH key specifically for GitHub Actions:

```bash
ssh-keygen -t rsa -b 4096 -C "github-actions" -f ./github-actions-key
```
This will create `github-actions-key` (private key) and `github-actions-key.pub` (public key).

### 2. Add Public Key to the Server

1.  Copy the content of `github-actions-key.pub`.
2.  SSH into your Google Cloud server.
3.  Add the key to `authorized_keys`:
    ```bash
    nano ~/.ssh/authorized_keys
    # Paste the key on a new line, save and exit.
    ```

### 3. Add Secrets to GitHub

1.  Go to your GitHub Repository > **Settings** > **Secrets and variables** > **Actions**.
2.  Click **New repository secret**.
3.  Add the following secrets:
    -   `GCP_HOST`: The External IP address of your VM.
    -   `GCP_USERNAME`: The username you use to SSH into the VM (e.g., `jeffrey`).
    -   `GCP_SSH_KEY`: The **Private Key** content from `github-actions-key` (the file without an extension). Copy the entire content including `-----BEGIN RSA PRIVATE KEY-----`.


### 4. Push to Deploy!

Now, whenever you push to `master`, GitHub Actions will:
1.  SSH into your server.
2.  Run the `deploy.sh` script.
3.  Pull the latest code, build, and restart the app.

---

## Management & Troubleshooting

### How to Delete a Prayer Request from the Database

You can interact with the SQLite database directly on the server.

1.  **Install SQLite CLI (if not already installed):**
    ```bash
    sudo apt update
    sudo apt install sqlite3
    ```

2.  **Open the Database:**
    Navigate to the project directory:
    ```bash
    cd ~/PrayerRequestsWall
    sqlite3 sqlite.db
    ```

3.  **Find the Entry ID:**
    ```sql
    SELECT * FROM prayer_requests;
    ```

4.  **Delete the Entry:**
    Replace `<ID>` with the actual ID of the request you want to delete.
    ```sql
    DELETE FROM prayer_requests WHERE id = <ID>;
    ```

5.  **Exit:**
    Press `Ctrl+D` or type `.exit`.

### How to Reset WhatsApp Session (Login with different user)

To switch WhatsApp accounts, you need to clear the saved session data.

1.  **Stop the App:**
    ```bash
    pm2 stop prayer-wall
    ```

2.  **Delete the Session Folder:**
    ```bash
    rm -rf ~/PrayerRequestsWall/.wwebjs_auth
    ```

3.  **Restart and Re-scan:**
    It's easiest to run manually to scan the new QR code:
    ```bash
    cd ~/PrayerRequestsWall
    npm run start
    ```
    scan the QR code, then `Ctrl+C` to stop.

4.  **Restart PM2:**
    ```bash
    pm2 restart prayer-wall
    ```

### How to Update Environment Variables (Without pushing code)

Since `.env` is ignored by Git, you can update it directly on the server.

1.  **Edit the file:**
    ```bash
    nano ~/PrayerRequestsWall/.env
    ```

2.  **Update the values** (e.g., change `WHATSAPP_GROUP_ID`).

3.  **Save and Exit:**
    Press `Ctrl+O`, `Enter` to save, then `Ctrl+X` to exit.

4.  **Restart the App:**
    For the changes to take effect, restart the application:
    ```bash
    pm2 restart prayer-wall
    ```


### Troubleshooting: Browser Already Running / Session Locked

If you see an error like `Error: The browser is already running... Use a different userDataDir`, it means a previous process didn't close correctly and is locking the session.

1.  **Check for running processes:**
    ```bash
    ps aux | grep -E "chrome|chromium|node"
    ```
    If you see lines ending in `chrome` or `node` (other than your current shell), they might be the culprit.

2.  **Kill all Chrome/Puppeteer processes:**
    ```bash
    sudo pkill -f chrome
    sudo pkill -f chromium
    # BE CAREFUL: This kills all node processes. Only do this if you are sure.
    # sudo pkill -f node
    ```

3.  **Nuclear Option: Remove the Lock File manually:**
    If processes are dead but it still fails, the lock file is stale. Delete it:
    ```bash
    rm -rf ~/PrayerRequestsWall/.wwebjs_auth/session/SingletonLock
    ```

4.  **Restart your app:**
    ```bash
    pm2 restart prayer-wall
    ```
