# Deploying Prayer Requests Wall (Automated)

This guide covers the **fully automated** deployment pipeline using `gcloud compute ssh`.
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

### 2. Migration to Standard Directory (Run Once)
Run this locally to upload the hardened migration script, then SSH to run it:
```bash
# Upload script
gcloud compute scp migrate-deployment.sh project-intercessor:~/ --zone asia-south1-c

# Run on VM
gcloud compute ssh project-intercessor --zone asia-south1-c --command="chmod +x migrate-deployment.sh && ./migrate-deployment.sh"
```

### 3. Install Deployment Script Manually (Run Once)
Since verify Cloud Build does not have sudo access, manually install the deployment script:
```bash
# Upload deploy script
gcloud compute scp deploy-docker.sh project-intercessor:/tmp/ --zone asia-south1-c

# Move to secure location and set permissions
gcloud compute ssh project-intercessor --zone asia-south1-c --command="sudo mv /tmp/deploy-docker.sh /opt/deploy/deploy-docker.sh && sudo chown root:root /opt/deploy/deploy-docker.sh && sudo chmod 755 /opt/deploy/deploy-docker.sh"
```

### 3. Configure the VM
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
# This allows us to use absolute paths in the deployment script
sudo mkdir -p /var/intercessor/data /var/intercessor/data/backups
# Set ownership to your user (or the user docker runs as). 
# If your container runs as UID 1000 (standard), use:
sudo chown -R 1000:1000 /var/intercessor
# Otherwise, chown to your current user:
# sudo chown -R $USER:$USER /var/intercessor
```

### 3. Setup Project on VM
```bash
git clone <YOUR_REPO_URL>
cd PrayerRequestsWall
nano .env
```
Paste your `.env` content.
**Note**: You do **NOT** need to set `DOCKER_IMAGE_URL` or `DEPLOY_IMAGE` here. Cloud Build injects it automatically.

---

## Part 2: Cloud Build & Permissions

This is the "Magic" part. We use Google's IAM to let Cloud Build SSH into the VM without managing keys.

### 1. Create Artifact Registry Repository
- **Name**: `prayer-repository`
- **Format**: Docker
- **Region**: `asia-south1` (Mumbai)

### 2. Grant Permissions to Cloud Build
1.  Go to **Cloud Build** > **Settings**.
2.  Copy the **Service Account Email** (`[PROJECT-NUMBER]@cloudbuild.gserviceaccount.com`).
3.  Go to **IAM & Admin** > **IAM**.
4.  Find that email (or "Grant Access").

5.  Add the role: **Artifact Registry Writer**.
    *   *Why?* Allows Cloud Build to push images to the registry.
7.  Add the role: **Compute OS Login**.
    *   *Why?* Allows Cloud Build to SSH into your VM using least-privilege.
7.  *(Optional)* Add the role: **Service Account User**.
    *   *Why?* Only needed if Cloud Build performs actions *as* the VM's service account (impersonation). Not strictly required for just SSH if OS Login is fully configured.

### 3. Grant Permissions to VM Service Account
1.  Go to **IAM & Admin** > **IAM**.
2.  Find the **Compute Engine default service account** (or whichever SA your VM uses).
3.  Add the role: **Artifact Registry Reader**.
    *   *Why?* Allows the VM to pull images without `gcloud auth login`.

### 4. Enable OS Login
For Cloud Build to SSH via OS Login, it must be enabled.
1.  **Project-wide** (Recommended):
    Go to **Compute Engine** > **Metadata**. Add `enable-oslogin` = `TRUE`.
2.  **Or Per-VM**:
    Edit your VM instance > **Custom Metadata**. Add `enable-oslogin` = `TRUE`.

### 3. Configure Cloud Build Trigger
1.  Go to **Cloud Build** > **Triggers**.
2.  Create Trigger:
    -   **Name**: `deploy-production`
    -   **Event**: Push to branch `master`.
    -   **Source**: Your GitHub Repo.
    -   **Configuration**: `cloudbuild.yaml`.
3.  **Substitutions** (Crucial Step):
    You must match the variables in `cloudbuild.yaml` or override them here:
    -   `_VM_ZONE`: **MUST MATCH** your VM's zone (e.g., `asia-south1-c`).
    -   `_VM_NAME`: `project-intercessor`.

---

## Part 3: Deploy!

Push to master:
```bash
git add .
git commit -m "Configure auto-deploy"
git push origin master
```

### How it works
1.  **Build**: Creates docker image tagged with the Git Commit SHA (e.g., `:a1b2c3d`).
2.  **Push**: Uploads to Artifact Registry.
3.  **SSH**: Cloud Build uses its IAM role to create a temporary SSH key, connects to the VM, and runs:
    ```bash
    export DOCKER_IMAGE_URL=...:a1b2c3d
    ./deploy-docker.sh
    ```
4.  **Update**: The script pulls the specific image, backs up the database, and restarts the container.
    *   *Note*: The VM does **not** `git pull` code. It runs exactly what was built in Cloud Build.

---

---

---

## Part 4: WhatsApp Authentication (First Run Only)

After your first deployment, the app will start but won't be connected to WhatsApp yet. You need to scan the QR code.

1.  **SSH into the VM**:
    Go to GCP Console > Compute Engine > VM Instances > click **SSH** next to `project-intercessor`.

2.  **View the Logs**:
    Run this command to see the real-time logs of your app:
    ```bash
    cd PrayerRequestsWall
    docker-compose logs -f app
    ```

3.  **Scan the QR Code**:
    -   You will see a QR code generated in the terminal (it might take a moment to appear).
    -   Open WhatsApp on your phone > Linked Devices > **Link a Device**.
    -   Scan the code on your screen.

4.  **Verification**:
    -   The logs should say "Client is ready!".
    -   **Persistence**: The session is now saved to `/var/intercessor/data/.wwebjs_auth`. You won't need to scan again for future deployments unless you explicitly delete that folder.

---

## Part 5: Managing the Database

Since the database is a standard SQLite file stored on the VM at `/var/intercessor/data/sqlite.db`, you can access it directly to inspect data or manually delete entries.

1.  **SSH into the VM**:
    ```bash
    gcloud compute ssh project-intercessor --zone asia-south1-c
    ```

2.  **Install SQLite3 Tool** (Run once):
    ```bash
    sudo apt update && sudo apt install -y sqlite3
    ```

3.  **Open the Database**:
    ```bash
    sqlite3 /var/intercessor/data/sqlite.db
    ```

4.  **Run SQL Commands**:
    ```sql
    -- List all tables
    .tables

    -- See the last 5 prayer requests
    SELECT id, content, created_at FROM prayer_requests ORDER BY created_at DESC LIMIT 5;

    -- Delete a specific request by ID
    DELETE FROM prayer_requests WHERE id = 123;

    -- Exit the tool
    .quit
    ```

---

## Security Best Practices

1.  **Session Data Permissions**:
    The `.wwebjs_auth` folder contains sensitive WhatsApp session data. Lock it down on the VM:
    ```bash
    chmod -R 700 .wwebjs_auth
    ```

2.  **Environment Variables**:
    Ensure your `.env` file is only readable by the owner:
    ```bash
    chmod 600 .env
    ```

---

## Troubleshooting

-   **"Insufficient Permission"**:
    -   Check that Cloud Build SA has `roles/compute.osLogin` and `roles/artifactregistry.writer`.
    -   Ensure OS Login is enabled on the VM (`enable-oslogin=TRUE`).
    -   Ensure the VM Zone in the Trigger matches the actual VM.
    -   **DO NOT** grant `roles/compute.instanceAdmin.v1` unless absolutely necessary.
-   **"Zone mismatch"**: Ensure `_VM_ZONE` in Cloud Build Trigger matches the VM's actual zone.
-   **Application Error**: Check VM logs: `docker-compose logs -f app`.
