# Deploying Prayer Requests Wall (Automated)

This guide covers the **fully automated** deployment pipeline using Google Cloud Build and `gcloud compute ssh`.
Pushing to `master` triggers: Build → Push to Artifact Registry → SCP + SSH into VM → Deploy.

---

## Architecture Overview

| Component | Details |
|---|---|
| VM | `project-intercessor`, zone `asia-south1-c`, machine type `e2-small` |
| OS | Debian 12 (Bookworm) |
| SSH Auth | **Metadata-based** (OS Login is disabled). Cloud Build injects ephemeral keys for `deploy-user`. |
| Deploy user | `deploy-user` — local Linux account, member of `docker` and `google-sudoers` groups |
| Container registry | Artifact Registry (`asia-south1-docker.pkg.dev`) |
| Logging | `gcplogs` driver → Google Cloud Logging, queryable by container name |

---

## Part 1: Infrastructure Setup

### 1. Create the VM

- **Name**: `project-intercessor`
- **Region/Zone**: `asia-south1-c`
- **Machine Type**: `e2-small` (2 vCPU, 2 GB RAM)
- **OS**: Debian 12 (Bookworm)
- **Firewall**: Allow HTTP and HTTPS traffic
- **Service Account**: Compute Engine default service account
- **OS Login**: Leave **disabled** (keep `enable-oslogin = FALSE` in instance metadata)

Add the following **startup script** under **Management > Automation** when creating the VM. It runs once on first boot and installs Docker and Docker Compose:

```bash
#!/bin/bash
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
curl -SL https://github.com/docker/compose/releases/download/v2.24.6/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
systemctl enable docker
systemctl start docker
```

### 2. Configure the VM

SSH into the VM (as yourself via the GCP Console or `gcloud compute ssh`) and run:

```bash
# Configure swap (required for e2-small with <2 GB RAM)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Install Google Cloud CLI (needed for Artifact Registry auth inside Docker)
sudo apt-get install -y apt-transport-https ca-certificates gnupg curl
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli

# Create persistent data directories (paths are volume-mounted in docker-compose.prod.yml)
sudo mkdir -p /var/intercessor/app
sudo mkdir -p /var/intercessor/data/wwebjs_auth
sudo mkdir -p /var/intercessor/data/backups
sudo mkdir -p /var/intercessor/data/certbot/conf
sudo mkdir -p /var/intercessor/data/certbot/www
sudo chown -R 1000:1000 /var/intercessor/data

# Create the deploy-user account used by Cloud Build for SSH
sudo useradd -m -s /bin/bash deploy-user
sudo usermod -aG docker deploy-user
sudo usermod -aG google-sudoers deploy-user
sudo mkdir -p /home/deploy-user/.ssh
sudo chmod 700 /home/deploy-user/.ssh
sudo chown -R deploy-user:deploy-user /home/deploy-user/.ssh
```

### 3. Create the `.env` File on the VM

```bash
sudo nano /var/intercessor/app/.env
```

Populate with all required environment variables. The `env_file` directive in `docker-compose.prod.yml` references this path.

---

## Part 2: Cloud Build & Permissions

### 1. Create Artifact Registry Repository

- **Name**: `prayer-repository`
- **Format**: Docker
- **Region**: `asia-south1`

### 2. Grant Roles to the Cloud Build Service Account

The Cloud Build SA email is `[PROJECT-NUMBER]@cloudbuild.gserviceaccount.com`. Assign the following roles via **IAM & Admin > IAM**:

| Role | Purpose |
|---|---|
| `roles/artifactregistry.writer` | Push Docker images |
| `roles/artifactregistry.reader` | Pull cached images during build |
| `roles/compute.admin` | Inject SSH keys into project metadata and connect to VM |
| `roles/compute.osAdminLogin` | Grants sudo on the VM via OS Login (kept for compatibility) |
| `roles/compute.osLogin` | OS Login access |
| `roles/iam.serviceAccountUser` | Impersonate the VM's service account |
| `roles/logging.logWriter` | Write logs to Cloud Logging |
| `roles/logging.viewAccessor` | View log buckets |
| `roles/logging.viewer` | View logs in Logs Explorer |
| `roles/monitoring.metricWriter` | Write monitoring metrics |
| `roles/run.admin` | Cloud Run admin (if applicable) |

### 3. Grant Roles to the VM's Compute Engine Service Account

The default SA email is `[PROJECT-NUMBER]-compute@developer.gserviceaccount.com`. It needs:

- `roles/artifactregistry.reader` — to pull images from Artifact Registry

### 4. Configure the Cloud Build Trigger

1. Go to **Cloud Build > Triggers** and create a trigger:
   - **Event**: Push to branch `master`
   - **Source**: Your GitHub repository
   - **Configuration file**: `cloudbuild.yaml`
2. The following substitutions are defined in `cloudbuild.yaml` and can be overridden here if needed:
   - `_VM_NAME`: `project-intercessor`
   - `_VM_ZONE`: `asia-south1-c`
   - `_ARTIFACT_REGION`: `asia-south1`
   - `_REPOSITORY`: `prayer-repository`
   - `_IMAGE_NAME`: `prayer-wall-app`

---

## Part 3: How the CI/CD Pipeline Works

Pushing to `master` triggers `cloudbuild.yaml`, which runs these steps:

1. **Pull cache** — pulls the latest image from Artifact Registry to use as a Docker build cache layer.
2. **Build** — builds the Docker image, tagged with `$COMMIT_SHA` and `latest`.
3. **Push** — pushes both tags to Artifact Registry.
4. **Deploy** — connects to the VM as `deploy-user` via metadata-based SSH and:
   - SCPs `docker-compose.prod.yml` to `/tmp/` on the VM
   - Moves it to `/var/intercessor/app/`
   - Runs `docker-compose pull` to fetch the new image
   - Stops and removes the old `app` container
   - Starts all containers with `docker-compose up -d`
   - **Cleans up** stale `deploy-user` ephemeral SSH keys from project metadata to prevent accumulation (which would cause future SSH timeouts)

### Note on SSH Key Management

Cloud Build uses **metadata-based SSH** (not OS Login). On each run it injects an ephemeral keypair into GCP project metadata under the `deploy-user` username. These keys are **never automatically removed** by GCP, so `cloudbuild.yaml` explicitly strips all `deploy-user` entries from project metadata at the end of every successful deploy. If keys accumulate (e.g., after failed builds), clean them manually:

```bash
gcloud compute project-info describe --project=YOUR_PROJECT_ID \
  --format="value(commonInstanceMetadata.items['ssh-keys'])" \
  | grep -v "^deploy-user:" > /tmp/cleaned.txt

gcloud compute project-info add-metadata \
  --project=YOUR_PROJECT_ID \
  --metadata-from-file=ssh-keys=/tmp/cleaned.txt
```

---

## Part 4: SSL/HTTPS Setup (Certbot)

Nginx is the reverse proxy. Certbot runs as a sidecar container and renews certificates every 12 hours.

### Initial Certificate Request (first-time only)

SSH into the VM and run:

```bash
cd /var/intercessor/app
docker-compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot --webroot-path=/var/www/certbot \
  -d yourdomain.com
```

Certificates are persisted at `/var/intercessor/data/certbot/conf`.

---

## Part 5: WhatsApp Authentication (First Run)

WhatsApp Web.js requires a QR code scan on first launch. Session data is persisted so this only happens once.

1. SSH into the VM.
2. Tail the app logs:
   ```bash
   cd /var/intercessor/app
   docker-compose -f docker-compose.prod.yml logs -f app
   ```
3. Scan the QR code shown in the terminal using WhatsApp on your phone.
4. Logs should show `Client is ready!`. Session is saved to `/var/intercessor/data/wwebjs_auth`.

---

## Part 6: Viewing Logs in Google Cloud Logging

All containers use the `gcplogs` logging driver and write directly to Google Cloud Logging. Logs are queryable **by container name** — no SSH or container ID lookup required.

In **Logs Explorer**, filter by container name:

```
resource.type="gce_instance"
jsonPayload."container.name"="prayer-wall-app-prod"
```

Container names:
- `prayer-wall-app-prod` — Next.js application
- `prayer-wall-nginx-prod` — Nginx reverse proxy
- `prayer-wall-certbot` — Certbot renewal sidecar

---

## Part 7: Managing the Database

The SQLite database is bind-mounted at `/var/intercessor/data/sqlite.db`.

```bash
sqlite3 /var/intercessor/data/sqlite.db
# e.g. SELECT * FROM prayer_requests;
```

---

## Troubleshooting

- **Permission Denied (SSH) during Cloud Build**: Stale `deploy-user` SSH keys have accumulated in project metadata. Run the cleanup command in Part 3 above.
- **Docker image pull error on VM**: Verify `roles/artifactregistry.reader` is assigned to the Compute Engine default service account, and that `gcloud auth configure-docker asia-south1-docker.pkg.dev` has been run on the VM.
- **WhatsApp QR not showing**: Check app logs — `docker-compose -f docker-compose.prod.yml logs -f app`.
- **Containers not starting**: Check for `.env` file at `/var/intercessor/app/.env` on the VM.
