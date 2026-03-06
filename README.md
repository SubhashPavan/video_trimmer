# Video Cutter

A web application to upload `.mp4` videos, cut them into multiple parts using timestamps, and download each part. Built with Node.js, Express, and FFmpeg.

---

## Features

- Upload `.mp4` videos (drag & drop or file browser)
- Built-in video player with visual timeline
- Add cut points at current playback time or enter manually
- Preview resulting segments before splitting
- Fast splitting using stream copy (no re-encoding)
- Download parts individually or all at once (`filename_part1.mp4`, `_part2.mp4`, etc.)
- Auto-cleanup of temporary files

---

## Run Locally

```bash
# Clone
git clone https://github.com/SubhashPavan/video_trimmer.git
cd video_trimmer

# Install dependencies
npm install

# Start server
npm start

# Open in browser
# http://localhost:3000
```

---

## Deploy to AKS

### Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

### Step 1 — Login to Azure

```bash
az login
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"
```

### Step 2 — Create Resource Group

```bash
az group create --name rg-videocutter --location eastus
```

### Step 3 — Create Azure Container Registry (ACR)

```bash
az acr create \
  --resource-group rg-videocutter \
  --name videocutteracr \
  --sku Basic
```

### Step 4 — Build and Push Docker Image

```bash
az acr login --name videocutteracr

docker build -t videocutteracr.azurecr.io/video-cutter:v1 .

docker push videocutteracr.azurecr.io/video-cutter:v1
```

### Step 5 — Create AKS Cluster

```bash
az aks create \
  --resource-group rg-videocutter \
  --name aks-videocutter \
  --node-count 1 \
  --node-vm-size Standard_B2s \
  --attach-acr videocutteracr \
  --generate-ssh-keys
```

### Step 6 — Connect kubectl to AKS

```bash
az aks get-credentials \
  --resource-group rg-videocutter \
  --name aks-videocutter

# Verify
kubectl get nodes
```

### Step 7 — Deploy

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

### Step 8 — Get Public IP

```bash
kubectl get svc video-cutter --watch
```

Wait until `EXTERNAL-IP` changes from `<pending>` to an IP address, then open `http://<EXTERNAL-IP>` in your browser.

---

## Update Deployment

After making code changes:

```bash
# Build new image
docker build -t videocutteracr.azurecr.io/video-cutter:v2 .
docker push videocutteracr.azurecr.io/video-cutter:v2

# Update the running pod
kubectl set image deployment/video-cutter \
  video-cutter=videocutteracr.azurecr.io/video-cutter:v2
```

---

## Useful Commands

```bash
# Check pod status
kubectl get pods

# View pod logs
kubectl logs -l app=video-cutter -f

# Restart pods
kubectl rollout restart deployment/video-cutter

# Scale replicas
kubectl scale deployment video-cutter --replicas=3

# Delete deployment
kubectl delete -f k8s/
```

---

## Cleanup (avoid charges)

```bash
# Delete everything
az group delete --name rg-videocutter --yes --no-wait
```

---

## Configuration

Environment variables (set in `k8s/deployment.yaml`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `MAX_FILE_SIZE` | `2147483648` | Max upload size in bytes (2GB) |
| `CLEANUP_AGE_MS` | `1800000` | Auto-delete files older than this (30 min) |

---

## Project Structure

```
.
├── index.html          # Frontend (single page)
├── server.js           # Express + FFmpeg backend
├── package.json
├── Dockerfile
├── .dockerignore
├── .gitignore
└── k8s/
    ├── deployment.yaml # Pod spec, health checks, volumes
    ├── service.yaml    # LoadBalancer service
    └── ingress.yaml    # NGINX ingress (optional, for custom domain)
```
