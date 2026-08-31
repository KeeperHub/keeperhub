# Self-hosted KeeperHub

Installs KeeperHub into a Kubernetes cluster you own, with no AWS account.

The running product depends on no service KeeperHub operates. The install itself
reaches exactly one, the Helm chart repository, and `CHART_REPO_URL` or
`CHART_DIR` avoids that too. [DEPENDENCIES.md](DEPENDENCIES.md) lists every host
the build, the install and the running product contact, what each one is for,
and how to switch it off or point it elsewhere.

A peer of `../staging/` and `../prod/`: the same `keeperhub-stack` umbrella chart,
the same structure, different values. Diff `values.yaml` against
`../staging/values.yaml` when changing either. This profile is only trustworthy
while it stays structurally identical to what staging and production run.

## Layout

| Path | What it is |
| --- | --- |
| `DEPENDENCIES.md` | every external host the build, install and running product reach, and how to turn each off |
| `values.yaml` | chart values common to every install, and the `global:` block you set |
| `values.db-{bundled,byo}.yaml`, `values.queue-{bundled,byo}.yaml` | the parts that differ per mode, merged over `values.yaml` |
| `values.queue-byo-endpoint.yaml` | merged only when `QUEUE_MODE=byo` and `AWS_ENDPOINT_URL` is set |
| `values.queue-aws-credentials.yaml` | merged only when `QUEUE_MODE=byo` with real AWS credentials |
| `values.minikube.yaml` | overlay for the throwaway cluster the test harness builds |
| `config.sh` | environment settings the installer turns into helm flags |
| `install.sh` | optional wrapper: preflight checks, then `helm upgrade --install` |
| `test-harness/` | scaffolding to try it on a throwaway minikube cluster, not part of the product |

`deploy/local/` is unrelated. That is the developers' local-deployment setup and
this work does not touch it.

## These are ordinary Helm values

The values files are valid Helm input. `install.sh` is a convenience, not a
requirement, and nothing here needs pre-processing before `helm` reads it.

That was not true before: the files carried `${VAR}` placeholders resolved by
`envsubst`, and because Helm treats `${VAR}` as literal text, reading one
directly did not fail - it produced a broken release. Everything a client sets
now lives under `global:` in `values.yaml`, and every place that consumes one of
those values is declared `type: template`, which the chart renders through `tpl`.

The namespace is never configured. `{{ .Release.Namespace }}` is used wherever it
is needed, so `--namespace` is the only place it is written.

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
# cluster.
DB_MODE=byo DB_SECRET_NAME=my-db QUEUE_MODE=byo \
  AWS_ENDPOINT_URL=http://my-q.my-ns.svc.cluster.local:9324 \
  SQS_QUEUE_URL=http://my-q.my-ns.svc.cluster.local:9324/000000000000/keeperhub-workflow-queue \
  SQS_DLQ_URL=http://my-q.my-ns.svc.cluster.local:9324/000000000000/keeperhub-workflow-queue-dlq \
  ./install.sh
```

All four combinations compose, so a bundled database with an external queue, or
an external database with the bundled queue, are both valid.

#### Authenticating to real AWS SQS

Staging and production use IRSA, which needs an EKS cluster with an OIDC
provider and an IAM role that trusts it. A self-hosted cluster usually has
neither, so supply credentials instead:

```bash
DB_MODE=byo QUEUE_MODE=byo \
  SQS_QUEUE_URL=https://sqs.<region>.amazonaws.com/<acct>/<queue> \
  SQS_DLQ_URL=https://sqs.<region>.amazonaws.com/<acct>/<queue>-dlq \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... [AWS_SESSION_TOKEN=...] ./install.sh
```

`install.sh` puts them in a Kubernetes Secret and the values reference it, so no
credential is ever written to a values file. `AWS_SESSION_TOKEN` is optional and
carries the temporary-credential case, so an assumed role works as well as a
long-lived key. Supply both key and secret or neither: half a pair falls back to
the default credential chain, which on a cluster without IRSA means no
credentials at all, so the installer refuses it.

Leave all three unset if the cluster already provides credentials, through IRSA,
an instance profile, or anything else the AWS default chain understands. Grant
the identity only `SendMessage`, `ReceiveMessage`, `DeleteMessage`,
`GetQueueUrl` and `GetQueueAttributes` on the queue, plus `SendMessage` on the
dead-letter queue.

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

The chart grants the database owner `SET` on `session_replication_role`. The
upstream test suite sets it while deleting rows, to suppress the append-only
trigger on the audit log; without the grant, two of the three call sites run in
Playwright's global setup and abort the whole run before any test executes. It
is not an escalation, because the owner already owns every table and can disable
those triggers directly. Drop `grantSetOnParameters` from
`values.db-bundled.yaml` if you would rather it fail closed.

That grant rides on a bootstrap hook, which CloudNativePG runs exactly once when
it creates the cluster. On a database that already exists, issue it by hand:

```sql
GRANT SET ON PARAMETER session_replication_role TO keeperhub;
```

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

#### Backing up the queue volume

Do not. Restore the queue from an empty volume and let the producers re-drive.

That is a deliberate position, not an omission. The volume holds work in flight
for seconds to minutes, so any backup is stale before it is written, and
restoring one re-delivers messages whose executions already finished. The queue
carries no record you cannot rebuild: workflow definitions, schedules and
execution history all live in PostgreSQL, which is the thing worth backing up.

What protects in-flight work is persistence plus the visibility timeout, both
measured rather than assumed. A queue restart keeps every message
(`test-harness/queue-restart-test.sh`, 10 restarts x 25 messages, none lost),
and a consumer that dies mid-message gets the message re-delivered when its
300s visibility timeout expires. Between them a restart is an outage of seconds,
not data loss.

If your compliance regime requires the volume be snapshotted anyway, snapshot
the PVC with whatever your CSI driver provides and treat the result as
diagnostic material, not as something to restore into a live queue.

If you are upgrading an install that predates this, the namespace already has an
`elasticmq` Service that Helm did not create and will refuse to adopt. Delete the
old Deployment and Service once before installing. That drops whatever is
in-flight, which is precisely the failure mode persistence exists to end.

## Installing

Two supported paths. They produce the same release.

### Plain helm

Write your own values file with the handful of settings that are yours:

```yaml
# my-install.yaml
global:
  image:
    repository: registry.example.com/keeperhub
    tag: v1.4.0
  appHost: keeperhub.example.com
  tlsIssuer: letsencrypt-prod
  fromAddress: noreply@example.com
  turnstileSecretKey: "<your Turnstile secret key>"
```

Then install, choosing one db fragment and one queue fragment:

```bash
helm repo add techops-services https://techops-services.github.io/helm-charts
helm install keeperhub techops-services/keeperhub-stack --version 0.5.0 \
  --namespace keeperhub --create-namespace \
  -f values.yaml \
  -f values.db-bundled.yaml \
  -f values.queue-bundled.yaml \
  -f my-install.yaml \
  --atomic --wait --timeout 15m
```

A value you have to set but did not stops the render naming the value, rather
than installing something that cannot start.

### With the installer

```bash
KUBE_CONTEXT=<your-context> \
  IMAGE_REPO=registry.example.com/keeperhub IMAGE_TAG=v1.4.0 \
  APP_HOST=keeperhub.example.com ./install.sh
```

`KUBE_CONTEXT` is required and never guessed. A bare `kubectl` follows whatever
context is current, which on a machine with production access is how an install
lands somewhere it should not.

What the wrapper adds over plain helm:

- it refuses to run against a cluster you did not name
- it checks the CloudNativePG CRD exists before `DB_MODE=bundled` needs it, so a
  missing operator is a message rather than a rolled-back release
- it checks the bring-your-own database Secret exists, for the same reason
- it refuses half an AWS key pair
- it refuses to install without a SendGrid key and a sender address, because an
  install without mail cannot complete a signup
- it puts real AWS credentials in a Secret rather than a values file
- it reports which optional runner credentials are absent, which nothing else does

Every setting lives in `config.sh` and can be overridden in the environment:
`NAMESPACE`, `APP_HOST`, `INGRESS_CLASS`, `TLS_ISSUER`, `IMAGE_REPO`,
`SENDGRID_API_KEY`, `FROM_ADDRESS`, `TURNSTILE_SECRET_KEY`, the
`DB_MODE`/`QUEUE_MODE` settings above, and the `PG_*` and `SQS_*` values behind
them.

`--dry-run` renders the chart without touching the cluster. `PROFILE=minikube`
merges the test-harness overlay. `CHART_DIR` points the install at a working-tree
copy of the chart, for developing chart changes alongside this profile.

## Secrets

The chart generates them (`secrets.generate` is on in `values.yaml`), so an
install needs no secret manager. Two of the values have formats that are not
interchangeable and fail in ways that do not look like a format problem, which is
why this is worth doing in the chart rather than in an instruction here: both
HMAC keys must base64 decode to exactly 32 bytes, and the integration encryption
key must be 64 hex characters.

Each key resolves as an explicit value first, then whatever is already in the
cluster, then a generated one. The middle step is what stops an upgrade rotating
a key.

`SENDGRID_API_KEY` and the three `TURNKEY_` keys are never generated. They are
rendered empty, because an invented API key replaces a clean unconfigured state
with 401s. They come from `secrets.values`, and `install.sh` passes
`SENDGRID_API_KEY` there for you. Supply the `TURNKEY_` keys yourself when you
have them.

Two things to know before relying on this:

- The "keep what is installed" step reads the cluster, and `helm template` does
  not. A `helm template | kubectl apply` pipeline **rotates these keys on every
  run**, and losing the integration encryption key orphans every stored
  credential. Pin them under `secrets.values` if you deploy that way.
- Changing a secret does not restart the pods reading it, because an env var is
  resolved once at pod start. Roll them yourself:
  `kubectl rollout restart deployment -l app.kubernetes.io/instance=keeperhub`.

Every generated Secret carries `helm.sh/resource-policy: keep`, so an `--atomic`
rollback of a failed first install does not delete the credentials the database
was just bootstrapped with.

## Trying it on a throwaway cluster

```bash
./test-harness/bootstrap-cluster.sh                    # minikube + calico + cert-manager + cloudnative-pg
IMAGE_TAG=$(./test-harness/build-images.sh --print-tag)
./test-harness/build-images.sh
KUBE_CONTEXT=keeperhub PROFILE=minikube IMAGE_TAG=$IMAGE_TAG ./install.sh
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

**Any hostname works, provided the origin is trusted.** `lib/trusted-origins.ts`
ships a fixed list covering `http://localhost:*`, `http://127.0.0.1:*` and
`https://*.keeperhub.com`, and that list backs the CSRF guard in `proxy.ts` and
`lib/middleware/auth-helpers.ts`. An origin outside it has every
cookie-authenticated POST/PATCH/PUT/DELETE rejected while the UI still loads and
reads, so it looks like the app works until you try to save: enabling a workflow
returns "Failed to update workflow state" and the only trace is
`[csrf] blocked: untrusted origin` in the app log.

This profile sets `ADDITIONAL_TRUSTED_ORIGINS` from `global.appHost`, so your own
domain is trusted without further configuration. Set it yourself only if the app
is reached on more origins than that one - a vanity domain, or a separate
hostname for an internal network.

**The client address comes from a header you name.** `lib/auth.ts` and
`lib/security/login-risk.ts` read `CLIENT_IP_HEADERS`, which defaults to
`CF-Connecting-IP`. Only Cloudflare sets that header, so on your cluster nothing
resolves an address unless you name the one your ingress controller sets. The
failure is quiet and it cuts both ways: sessions record no address, and signup
throttling stops counting per caller and counts everyone in a single bucket, so
the whole install shares one allowance of 5 signups per hour.

This profile sets `CLIENT_IP_HEADERS=X-Real-IP`, which is what ingress-nginx
sets. Change it if your controller sets a different one. Name a header carrying a
single value; a header with several comma-separated hops is refused, because the
leftmost hop is whatever the caller sent. If the header does carry several hops,
list your own proxies in `CLIENT_IP_TRUSTED_PROXIES` and the chain is read from
the right instead.

One thing to check before you trust any of this. On a cluster with no cloud
load balancer, traffic can arrive at a node that does not host the ingress
controller and be forwarded to the node that does, which replaces the client
address with an internal one. The header is then set correctly to the wrong
address, and no setting here helps. Running the controller as a DaemonSet
preserves the real address.

**Email needs a SendGrid account of your own.** `lib/email.ts` posts to
SendGrid's HTTP API, so there is no SMTP setting and no local mail-catcher
option. SendGrid is the only supported sender, and it is a required dependency
rather than an optional one: verification codes, invitations, password resets
and MFA step-up codes all go through it.

Set `SENDGRID_API_KEY` to a key from your own account, and `FROM_ADDRESS` to a
sender identity verified in that same account. `install.sh` refuses to install
without both, because the failure mode otherwise is quiet - everything is
generated and stored, nothing is delivered, and signup dead-ends at "enter the
6-digit code".

If your egress policy forbids a direct call to SendGrid, set `SENDGRID_API_URL`
to a relay of yours that accepts SendGrid's v3 `mail/send` request shape. That
changes where the request goes, not what speaks it.

One thing the product does not tell you: a failed send on the invitation path is
invisible to the person who sent the invitation. `sendInvitationEmail` returns
false rather than throwing, the caller ignores the return value, and the log line
is a warning that does not page. The invitation row is still written, so a
revoked or wrong key looks exactly like a working one there. Test a real
invitation after you change the key.

**Code action nodes fail.** No sandbox is deployed, so `SANDBOX_URL` points at
nothing. Everything else runs.

**Wallets and signing do not work** unless you supply `TURNKEY_*`.

**A workflow can run, exit 0 and do nothing.** The executor hands runner Job pods
their credentials by `secretKeyRef`, and marks eight of the ten optional
(`keeperhub-executor/k8s-job.ts`). A runner with none of them therefore starts,
runs and reports success while every step that needed one silently did nothing.
There is no log line for it and no failed execution to find.

That optionality is application behaviour and this profile does not change it.
What it does is name the gap at install time: `install.sh` reports which of the
eight are absent and what stops working without each, and
`STRICT_RUNNER_SECRETS=true` turns that report into a refusal. Each is a Secret
whose key equals its name:

```bash
kubectl -n keeperhub create secret generic keeperhub-executor-openai-api-key \
  --from-literal=keeperhub-executor-openai-api-key=<value>
```

| Secret suffix | What stops working without it |
| --- | --- |
| `chain-rpc-config` | web3 steps have no RPC endpoints and cannot reach any chain |
| `etherscan-api-key` | contract ABI auto-fetch fails, so web3 steps needing an ABI fail |
| `metrics-ingest-token` | runner metrics are not shipped, so executions are invisible |
| `openai-api-key` | AI steps and AI workflow generation fail |
| `sendgrid-api-key` | email steps send nothing. This is the workflow plugin's key, not the one transactional mail uses. The two are separate settings and may hold different keys |
| `simple-account-7702-address` | EIP-7702 smart-account steps fail |
| `turnkey-api-private-key` | managed wallet signing fails |
| `turnkey-api-public-key` | managed wallet signing fails |

The other two, `db-url` and `integration-encryption-key`, are not optional there.
The chart creates both, so a missing one is not a degraded runner - it would be
`CreateContainerConfigError` on every Job pod.

## The queue URL is a cryptographic input

Producers sign `sqs\n<queueUrl>\n<caller>\n<sha256(body)>\n<ts>` and the executor
verifies against its own `SQS_QUEUE_URL`. A one-byte disagreement between any
producer and the consumer rejects every trigger as `bad_signature`, visible only
as a warn line while every pod stays green.

Under the bundled queue the chart computes the URL from the release namespace and
`strictEndpointCheck` fails the render if a component disagrees with it, so there
is nothing to keep in step by hand. Under `QUEUE_MODE=byo` you supply the URL and
nothing can check it for you - it is written once under `global.queue.url` and
read by all three components from there.

`SQS_HMAC_MODE` is `enforce` and the dead-letter queue is live, so a rejected
message is visible rather than simply gone.
