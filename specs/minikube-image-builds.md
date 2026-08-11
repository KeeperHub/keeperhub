# Minikube Image Builds

## Problem

Using `minikube image load` to transfer large Docker images (1.8GB+) causes:
- OOM kills (exit code 137)
- System slowdown
- Long transfer times

## Solution: Build Directly in Minikube's Docker

Instead of building locally and transferring, build directly inside minikube's Docker daemon:

```bash
# Set minikube Docker environment and build
DOCKER_TLS_VERIFY="1" \
DOCKER_HOST="tcp://192.168.49.2:2376" \
DOCKER_CERT_PATH="$HOME/.minikube/certs" \
docker build --target workflow-runner -t keeperhub-runner:latest .
```

Or for both scheduler images:

```bash
export DOCKER_TLS_VERIFY="1"
export DOCKER_HOST="tcp://192.168.49.2:2376"
export DOCKER_CERT_PATH="$HOME/.minikube/certs"

docker build --target scheduler -t keeperhub-scheduler:latest .
docker build --target workflow-runner -t keeperhub-runner:latest .
```

## Why This Works

- No image transfer between Docker daemons
- Build context is small (~10MB) vs full image (~1.8GB)
- Leverages minikube's Docker cache
- Same result as `minikube image load` but faster and lighter

## Getting Minikube Docker Env

To see the environment variables:

```bash
minikube docker-env
```

Output:
```
export DOCKER_TLS_VERIFY="1"
export DOCKER_HOST="tcp://192.168.49.2:2376"
export DOCKER_CERT_PATH="/home/user/.minikube/certs"
export MINIKUBE_ACTIVE_DOCKERD="minikube"
```

## Verify Image is Available

```bash
minikube ssh "docker images keeperhub-runner"
```

## When to Use `minikube image load`

Only use for:
- Small images (<500MB)
- Pre-built images from registries
- CI/CD pipelines with sufficient resources

## Updating the Makefile

The `build-scheduler-images` target could be updated to use this approach:

```makefile
build-scheduler-images-minikube:
	@echo "Building images directly in minikube's Docker..."
	DOCKER_TLS_VERIFY="1" \
	DOCKER_HOST="tcp://192.168.49.2:2376" \
	DOCKER_CERT_PATH="$(HOME)/.minikube/certs" \
	docker build --target scheduler -t keeperhub-scheduler:latest .
	DOCKER_TLS_VERIFY="1" \
	DOCKER_HOST="tcp://192.168.49.2:2376" \
	DOCKER_CERT_PATH="$(HOME)/.minikube/certs" \
	docker build --target workflow-runner -t keeperhub-runner:latest .
	@echo "Images ready in minikube!"
```
