# Deploying Prayer Requests Wall (Automated)

This guide covers the **fully automated** deployment pipeline using Google Cloud Build and `gcloud compute ssh`.
Pushing to `master` will Build -> Push -> SSH (via IAM) -> Deploy.

---

## Part 1: Infrastructure Setup

### 1. Create the VM
- **Name**: `project-intercessor`
- **Region/Zone**: `asia-south1-c` (or any zone in Mumbai).
- **Machine Type**: **e2-small** (2 vCPU, 2GB RAM).
- **OS**: Ubuntu 24.04 LTS.
- **Firewall**: Allow HTTP/HTTPS.
- **Service Account**: "Compute Engine default service account" with access to **Artifact Registry** (Storage Object Viewer).

### 2. Configure the VM
SSH into the VM and run:

```bash
# Update and install Docker
sudo apt update && sudo apt install -y docker.io docker-compose git

# Enable Docker for current user
sudo usermod -aG docker $USER
newgrp docker

# Configure Swap (CRITICAL for <2GB RAM)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Install Google Cloud SDK (Required for gcloud auth)
sudo apt-get install -y apt-transport-https ca-certificates gnupg curl
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli

# Configure Docker to verify images from Artifact Registry
gcloud auth configure-docker asia-south1-docker.pkg.dev

# Create Persistent Data Directories (CRITICAL)
# These paths are mapped in docker-compose.prod.yml
sudo mkdir -p /var/intercessor/app
sudo mkdir -p /var/intercessor/data/wwebjs_auth
sudo mkdir -p /var/intercessor/data/backups
sudo mkdir -p /var/intercessor/data/certbot/conf
sudo mkdir -p /var/intercessor/data/certbot/www

# Set ownership to your user (or UID 1000 for docker)
sudo chown -R 1000:1000 /var/intercessor/data
```

### 3. Initial Setup on VM
```bash
# Create initial .env file on VM
cd /var/intercessor/app
sudo nano .env
```
Paste your `.env` content. Ensure `PROJECT_ID` is set correctly if used.

---

## Part 2: Cloud Build & Permissions

We use Google's IAM to let Cloud Build SSH into the VM without managing keys manually.

### 1. Create Artifact Registry Repository
- **Name**: `prayer-repository`
- **Format**: Docker
- **Region**: `asia-south1` (Mumbai)

### 2. Grant Permissions to Cloud Build
1.  Go to **Cloud Build** > **Settings**.
2.  Copy the **Service Account Email** (`[PROJECT-NUMBER]@cloudbuild.gserviceaccount.com`).
3.  Go to **IAM & Admin** > **IAM**.
4.  Add the following roles to the Cloud Build Service Account:
    *   **Artifact Registry Writer**
    *   **Compute OS Login**
    *   **Service Account User** (to act as the VM's service account)

### 3. Grant Permissions to VM Service Account
1.  Add the role **Artifact Registry Reader** to the **Compute Engine default service account**.

### 4. Enable OS Login
1.  Go to **Compute Engine** > **Metadata**. 
2.  Add `enable-oslogin` = `TRUE`.

### 5. Configure Cloud Build Trigger
1.  Go to **Cloud Build** > **Triggers**.
2.  Create Trigger:
    -   **Event**: Push to branch `master`.
    -   **Source**: Your GitHub Repo.
    -   **Configuration**: `cloudbuild.yaml`.
3.  **Substitutions**:
    -   `_VM_ZONE`: Your VM's zone (e.g., `asia-south1-c`).
    -   `_VM_NAME`: `project-intercessor`.

---

## Part 3: Deploy!

Pushing to master triggers `cloudbuild.yaml`:
1.  **Build & Push**: Creates and uploads the Docker image.
2.  **SCP**: Copies `docker-compose.prod.yml` to the VM.
3.  **SSH**: Executes the deployment command:
    ```bash
    docker-compose -f docker-compose.prod.yml pull
    docker-compose -f docker-compose.prod.yml up -d
    ```

---

## Part 4: SSL/HTTPS Setup (Certbot)

The application uses Nginx as a reverse proxy with Certbot for SSL.

### 1. Initial Certificate Request
If this is a fresh setup, you need to run Certbot manually once to get the certificates:
```bash
docker-compose -f docker-compose.prod.yml run --rm certbot certonly --webroot --webroot-path=/var/www/certbot -d yourdomain.com
```

### 2. Automatic Renewal
The `certbot` container in `docker-compose.prod.yml` is configured to check for renewal every 12 hours.

---

## Part 5: WhatsApp Authentication (First Run)

1.  **SSH into the VM**.
2.  **View logs**:
    ```bash
    cd /var/intercessor/app
    docker-compose -f docker-compose.prod.yml logs -f app
    ```
3.  **Scan QR Code**: Use WhatsApp on your phone to scan the code in the terminal.
4.  **Verification**: Logs should show "Client is ready!". Session data is saved to `/var/intercessor/data/wwebjs_auth`.

---

## Part 6: Managing the Database

Database is located at `/var/intercessor/data/sqlite.db`.

```bash
sqlite3 /var/intercessor/data/sqlite.db
# Run your SQL commands (e.g., SELECT * FROM prayer_requests;)
```

---

## Troubleshooting

- **Permission Denied (SSH)**: Ensure Cloud Build SA has `roles/compute.osLogin` and OS Login is enabled project-wide.
- **Docker Image Pull Error**: Verify `Artifact Registry Reader` on the VM's service account.
- **WhatsApp QR not showing**: Check app logs `docker-compose logs -f app`.
