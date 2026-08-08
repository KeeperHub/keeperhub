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
| `values.yaml` | chart values common to every install |
| `values.db-{bundled,byo}.yaml`, `values.queue-{bundled,byo}.yaml` | the parts that differ per mode, merged over `values.yaml` |
| `values.queue-byo-endpoint.yaml` | merged only when `QUEUE_MODE=byo` and `AWS_ENDPOINT_URL` is set |
| `namespace.yaml`, `runner-sa.yaml` | resources applied alongside the release |
| `config.sh` | every value that has to agree across the install |
| `install.sh` | installs into an existing cluster |
| `test-harness/` | scaffolding to try it on a throwaway minikube cluster, not part of the product |

`deploy/local/` is unrelated. That is the developers' local-deployment setup and
this work does not touch it.

## What the install does not provide

It assumes a cluster and does not create one. You bring:

- Kubernetes 1.28 or later with a default StorageClass
- an ingress controller
- a cert-manager `ClusterIssuer`, if you want TLS
- container images the cluster can pull
- the CloudNativePG operator, if you want the chart to run PostgreSQL

## The database and the queue: bundled, or bring your own

Both are switchable, and both default to bundled so a first install needs nothing
but a cluster.

| | `DB_MODE` / `QUEUE_MODE` = `bundled` | = `byo` |
| --- | --- | --- |
| PostgreSQL | the chart renders a CloudNativePG `Cluster`, and the operator brings HA, failover, backup and restore with it | you create a Secret holding `DATABASE_URL` and name it in `DB_SECRET_NAME` |
| Queue | the chart runs ElasticMQ with a PVC | you point `SQS_QUEUE_URL` and `SQS_DLQ_URL` at your own queue, either real AWS SQS or your own SQS-compatible endpoint |

```bash
# The default: the chart runs both.
DB_MODE=bundled QUEUE_MODE=bundled ./install.sh

# Your own database, and real AWS SQS.
DB_MODE=byo DB_SECRET_NAME=my-db QUEUE_MODE=byo \
  SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<acct>/<queue> \
  SQS_DLQ_URL=https://sqs.us-east-1.amazonaws.com/<acct>/<queue>-dlq ./install.sh

# Your own database, and your own SQS-compatible queue somewhere else in the
# cluster. The URLs are derived from the endpoint when you do not give them.
DB_MODE=byo DB_SECRET_NAME=my-db QUEUE_MODE=byo \
  AWS_ENDPOINT_URL=http://my-queue.my-namespace.svc.cluster.local:9324 ./install.sh
```

All four combinations compose, so a bundled database with an external queue, or
an external database with the bundled queue, are both valid.

Under `QUEUE_MODE=byo` whether `AWS_ENDPOINT_URL` is set is itself the choice.
Left unset, the SDK talks to real AWS SQS and resolves credentials the normal
way (IRSA, instance profile, environment), which is how staging and production
are configured. Set, it talks to whatever you point it at, and static
credentials go with it because an explicit endpoint leaves no credential chain
to fall back on. That is why the two live in separate values files: absence and
presence are different behaviours, and a values file cannot express a
conditional key.

### Bundled PostgreSQL

Install the [CloudNativePG](https://cloudnative-pg.io/) operator first. It is a
prerequisite rather than a subchart because its CRDs are cluster-scoped:

```bash
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml
```

`install.sh` refuses to run without it rather than failing later inside a Helm
rollback.

Set `PG_INSTANCES=3` for a highly available cluster. One primary and two
replicas, failover handled by the operator, and the application follows it with
no configuration change because it connects through the `-rw` Service, which the
operator repoints. It needs three schedulable nodes; the default is 1 so a
single-node cluster does not sit forever waiting on anti-affinity.

Backup and restore are CloudNativePG's, not ours. Anything set under
`postgresql.backup` in the values reaches `spec.backup` on the `Cluster`
verbatim, and `postgresql.recovery` reaches `spec.bootstrap.recovery`, so you
configure a `barmanObjectStore` and restore from it exactly as CloudNativePG
documents.

The database host must be the fully qualified `.svc.cluster.local` name.
`ensureExplicitSslMode` in `lib/db/connection-utils.ts` only skips forcing
`sslmode=verify-full` for that suffix, and anything shorter then fails TLS
against the in-cluster certificate. This is why CloudNativePG's own generated
`uri` and `fqdn-uri` Secret keys cannot be used and `install.sh` composes the
connection string itself.

### Bundled queue

Single node, and that is not a placeholder to be improved later: ElasticMQ has
no clustering or replication, so a second replica would be a second independent
queue that silently splits messages. A restart is therefore a brief outage.
Persistence is what keeps it from also being data loss - messages are written to
a PVC and are still there afterwards, which
`test-harness/queue-restart-test.sh` measures directly.

One known deviation from real SQS: `PurgeQueue` is not persisted, so purged
messages reappear after a restart. Nothing in the application calls it; only
tests do.

If you are upgrading an install that predates this, the namespace already has an
`elasticmq` Service that Helm did not create and will refuse to adopt. Delete the
old Deployment and Service once before installing. That drops whatever is
in-flight, which is precisely the failure mode persistence exists to end.

## Installing

```bash
KUBE_CONTEXT=<your-context> IMAGE_TAG=<tag> ./install.sh
```

`KUBE_CONTEXT` is required and never guessed. A bare `kubectl` follows whatever
context is current, which on a machine with production access is how an install
lands somewhere it should not.

Everything else has a default in `config.sh` and can be overridden in the
environment: `NAMESPACE`, `APP_HOST`, `INGRESS_CLASS`, `TLS_ISSUER`,
`IMAGE_REPO`, the `DB_MODE`/`QUEUE_MODE` settings above, and the `PG_*` and
`SQS_*` values behind them.

`--dry-run` renders the manifests and the chart without touching the cluster.

`CHART_DIR` points the install at a working-tree copy of the chart instead of the
published one, for developing chart changes alongside this profile.

## Trying it on a throwaway cluster

```bash
./test-harness/bootstrap-cluster.sh                    # minikube + calico + cert-manager + cloudnative-pg
IMAGE_TAG=$(./test-harness/build-images.sh --print-tag)
./test-harness/build-images.sh
KUBE_CONTEXT=keeperhub IMAGE_TAG=$IMAGE_TAG ./install.sh
KUBE_CONTEXT=keeperhub ./test-harness/queue-restart-test.sh   # optional: measure queue durability
```

Then, to reach it:

```bash
minikube tunnel -p keeperhub
echo "$(minikube -p keeperhub ip) selfhosted.keeperhub.com" | sudo tee -a /etc/hosts
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
`selfhosted.keeperhub.com` to stay inside the trusted suffix. **A client cannot do
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
