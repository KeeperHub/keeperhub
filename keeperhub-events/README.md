# KeeperHub Events System

A comprehensive event tracking and processing system for the KeeperHub smart contract platform, built on Node.js with Docker and Kubernetes deployment support.

## Overview

This repository contains two main services:

- **event-tracker**: Monitors blockchain events and synchronizes them with the system

The system is designed to run in multiple deployment modes: local development, Docker Compose (with hybrid Minikube support), and full Kubernetes production environments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Compose Network                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐  │
│  │  sc-event-      │    │  sc-event-      │    │    Redis    │  │
│  │  tracker        │───▶│  worker         │    │   (sync)    │  │
│  │                 │    │  :3010          │    │   :6379     │  │
│  └────────┬────────┘    └────────┬────────┘    └──────▲──────┘  │
│           │                      │                     │         │
│           │                      │                     │         │
│           └──────────────────────┼─────────────────────┘         │
│                                  │                               │
└──────────────────────────────────┼───────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────┐
                          │  KeeperHub API  │
                          │   (external)    │
                          └─────────────────┘
```

## Quick Start with Docker Compose

### Prerequisites

- Docker and Docker Compose installed
- Access to KeeperHub API credentials

### Setup

1. **Clone the repository and navigate to the project directory:**

   ```bash
   cd keeperhub-events
   ```

2. **Create your environment file:**

   ```bash
   cp .env.docker .env
   ```

3. **Edit `.env` with your configuration:**

   ```bash
   # Required variables:
   KEEPERHUB_API_URL=https://api.keeperhub.example.com
   INTERNAL_SERVICE_HMAC_SECRET=your-internal-service-hmac-secret
   JWT_TOKEN_USERNAME=your-username
   JWT_TOKEN_PASSWORD=your-password
   ETHERSCAN_API_KEY=your-etherscan-key
   ```

4. **Start all services:**

   ```bash
   docker-compose up -d
   ```

5. **Check service status:**
   ```bash
   docker-compose ps
   ```

### Docker Compose Commands

| Command                                   | Description                      |
| ----------------------------------------- | -------------------------------- |
| `docker-compose up -d`                    | Start all services in background |
| `docker-compose down`                     | Stop and remove all containers   |
| `docker-compose logs -f`                  | Follow logs from all services    |
| `docker-compose logs -f event-tracker` | Follow tracker logs              |
| `docker-compose restart`                  | Restart all services             |
| `docker-compose build --no-cache`         | Rebuild images without cache     |

### Services

| Service            | Port | Description                                         |
| ------------------ | ---- | --------------------------------------------------- |
| `redis`            | 6379 | Redis for synchronization between tracker instances |
| `event-tracker` | -    | Monitors blockchain events                          |

### Environment Variables

See [`.env.docker`](.env.docker) for a complete list of configurable environment variables.

## Project Structure

```
keeperhub-events/
├── docker-compose.yml          # Docker Compose configuration
├── .env.docker                 # Environment variables template
├── event-tracker/           # Event tracker service
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
├── deploy/                     # Deployment configurations
│   ├── local/                  # Local/Minikube deployment
│   ├── event-tracker/       # Kubernetes values
└── workflows/                  # GitHub Actions workflows
```

## License

ISC
