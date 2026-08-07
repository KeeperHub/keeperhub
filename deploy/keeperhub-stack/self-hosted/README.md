# Self-hosted KeeperHub

Installs KeeperHub into a Kubernetes cluster you own, with no AWS account and no
dependency on any KeeperHub-operated service.

A peer of `../staging/` and `../prod/`: the same `keeperhub-stack` umbrella chart,
the same structure, different values. Diff `values.yaml` against
`../staging/values.yaml` when changing either. This profile is only trustworthy
while it stays structurally identical to what staging and production run.

## Layout

| Path | What it is |
| --- | --- |
| `values.yaml` | chart values |
| `namespace.yaml`, `elasticmq.yaml`, `runner-sa.yaml` | resources applied alongside the release |
| `config.sh` | every value that has to agree across the install |
| `install.sh` | installs into an existing cluster |
| `test-harness/` | scaffolding to try it on a throwaway minikube cluster, not part of the product |

`deploy/local/` is unrelated. That is the developers' local-deployment setup and
this work does not touch it.

## What the install does not provide

It assumes a cluster and does not create one. You bring:

- Kubernetes 1.28 or later with a default StorageClass
- an ingress controller
- PostgreSQL 17, reachable from the cluster
- a cert-manager `ClusterIssuer`, if you want TLS
- container images the cluster can pull

The queue is not on that list. A self-hosted install needs one and ElasticMQ is
what we support, so it is installed as part of the profile.

## Installing

```bash
KUBE_CONTEXT=<your-context> IMAGE_TAG=<tag> ./install.sh
```

`KUBE_CONTEXT` is required and never guessed. A bare `kubectl` follows whatever
context is current, which on a machine with production access is how an install
lands somewhere it should not.

Everything else has a default in `config.sh` and can be overridden in the
environment: `NAMESPACE`, `APP_HOST`, `INGRESS_CLASS`, `TLS_ISSUER`,
`IMAGE_REPO`, `DATABASE_URL_IN_CLUSTER`, and the queue settings.

`--dry-run` renders the manifests and the chart without touching the cluster.

## Trying it on a throwaway cluster

```bash
./test-harness/bootstrap-cluster.sh                    # minikube + calico + cert-manager + postgres
IMAGE_TAG=$(./test-harness/build-images.sh --print-tag)
./test-harness/build-images.sh
KUBE_CONTEXT=keeperhub IMAGE_TAG=$IMAGE_TAG ./install.sh
```

Then, to reach it:

```bash
minikube tunnel -p keeperhub
echo "$(minikube -p keeperhub ip) local.keeperhub.com" | sudo tee -a /etc/hosts
```

Note that `minikube status` without `-p keeperhub` reports on whatever profile
was active before and will likely say `Stopped` while this is running perfectly
well. `minikube profile list` shows the split: the `-p` flag drives `minikube`,
while `kubectl` follows its own current context.

The first run is slow and large. The images are big, the app image especially,
and `minikube image load` stores each one twice, once in your Docker daemon and
once in the node. Budget tens of minutes and around 25GB.

## Things that do not work yet, and why

These are properties of the shipped application, not of this profile. Each is
tracked separately.

**The app only runs on a `*.keeperhub.com` hostname.** `lib/trusted-origins.ts`
hardcodes the trusted-origin list to `http://localhost:*`, `http://127.0.0.1:*`
and `https://*.keeperhub.com`, with no environment variable to extend it. That
list backs the CSRF guard in `proxy.ts` and better-auth, so on any other
hostname every cookie-authenticated POST/PATCH/PUT/DELETE is rejected. The UI
loads and reads fine, so it looks like the app works until you try to save:
enabling a workflow returns "Failed to update workflow state" and the only trace
is `[csrf] blocked: untrusted origin` in the app log. `APP_HOST` defaults to
`local.keeperhub.com` to stay inside the trusted suffix. **A client cannot do
this** - they do not own the domain. Making trusted origins configurable is a
prerequisite for any client install (KEEP-1110).

**There is no email.** `lib/email.ts` posts to SendGrid's HTTP API, so there is
no SMTP setting and no local mail-catcher option. Without `SENDGRID_API_KEY`,
verification codes, invitations and password resets are generated and stored but
never delivered, and signup dead-ends at "enter the 6-digit code". Configurable
SMTP is KEEP-1119.

**Code action nodes fail.** No sandbox is deployed, so `SANDBOX_URL` points at
nothing. Everything else runs.

**Wallets and signing do not work** unless you supply `TURNKEY_*`.

**Two `parameterStore` entries remain** in `values.yaml`, and several credential
Secrets the workflow runner references are absent. Those references are optional,
so the runner starts and exits 0 looking healthy without them. Converting them to
plain Secret references is KEEP-1108.

## The queue URL is a cryptographic input

Producers sign `sqs\n<queueUrl>\n<caller>\n<sha256(body)>\n<ts>` and the executor
verifies against its own `SQS_QUEUE_URL`. A one-byte disagreement between any
producer and the consumer rejects every trigger as `bad_signature`, visible only
as a warn line while every pod stays green. That is why the URL is defined once
in `config.sh` and templated into all three components from there.

`SQS_HMAC_MODE` is `enforce` and the dead-letter queue is live, so a rejected
message is visible rather than simply gone.
