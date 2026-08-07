# Local Kubernetes stack

Runs the whole KeeperHub execution pipeline in minikube, with no AWS account and
no KeeperHub-operated service. This is the environment self-hosting work is
built and verified in, so it deliberately installs the same `keeperhub-stack`
umbrella chart that staging and production use, with only the values differing.

What runs:

| Component | Role |
| --- | --- |
| `keeperhub-app` | Next.js app, and owner of the `db-migration` initContainer |
| `keeperhub-schedule` | evaluates cron schedules and enqueues triggers |
| `keeperhub-executor` | consumes the queue and creates one Job per execution |
| workflow-runner Jobs | one short-lived pod per workflow execution |
| `elasticmq` | SQS-compatible queue |
| `postgresql` | database |
| cert-manager | issues the app certificate from your mkcert CA |

The block dispatcher and metrics collector are disabled by default. There is no
sandbox yet, so Code action nodes will fail; everything else works.

## Prerequisites

`minikube`, `kubectl`, `helm`, `docker`, `mkcert`, and at least 6GB of free
memory (8GB recommended) and ~40GB of free disk.

## From clone to a running workflow

```bash
make setup-local-kubernetes      # cluster, TLS, PostgreSQL, queue
make deploy-to-local-kubernetes  # build images, install the chart
```

Budget real time for the first run. The images are large, the app image especially,
and `minikube image load` copies each one into the cluster node, so it is stored
twice: once in your Docker daemon and once in the node. Expect tens of minutes
and around 25GB of disk the first time. Later runs skip both the build and the
load for anything unchanged.

Then, in a second terminal, expose the ingress and point a hostname at it:

```bash
minikube tunnel -p keeperhub
echo "$(minikube -p keeperhub ip) workflow.keeperhub.local" | sudo tee -a /etc/hosts
```

The app is at <https://workflow.keeperhub.local/>. The certificate chains to your
mkcert CA, so the browser trusts it with no warning.

To sign in and get seeded workflow fixtures:

```bash
kubectl --context keeperhub -n local port-forward svc/postgresql 5434:5432 &
DATABASE_URL="postgresql://local:local@localhost:5434/keeperhub" pnpm dev:bootstrap
```

Port 5434, not 5433. Docker Compose publishes its own postgres on 5433, and if
it is running the port-forward cannot bind. That failure is quiet, and anything
then connecting to `localhost:5433` reaches the Compose database instead of the
cluster one, which looks like wrong data rather than a connection error.

A scheduled workflow then runs end to end on its own. Watch it move:

```bash
make schedule-logs     # "Found N enabled schedules" then "Triggering workflow"
make executor-logs     # "Received 1 messages" then "Message deleted"
make executor-status   # the per-execution Job, 1/1 COMPLETIONS
make queue-status      # queue depths
```

Ground truth is the database, not the logs:

```sql
SELECT id, workflow_id, status, error_code, completed_at
FROM workflow_executions ORDER BY created_at DESC LIMIT 5;
```

`completed` is success. `phantom` means the trigger never left the dispatcher.

## A dedicated minikube profile

Everything runs in a minikube profile named `keeperhub`, not the default
`minikube` one, and every command pins `--context keeperhub`.

This is not incidental. The stack needs a NetworkPolicy-enforcing CNI, and a
cluster's CNI can only be chosen when it is created, so sharing the default
profile would mean destroying whatever else you keep there. Pinning the context
also means a local command cannot wander onto a real cluster that happens to be
your current context.

Override with `MINIKUBE_PROFILE` if you want a different name.

One consequence to know about, because it looks like a broken cluster when it
is not. Creating a profile does not make it the *active* one, so a bare
`minikube status` reports on whatever profile was active before, very likely
showing `Stopped` while this stack is running perfectly well:

```bash
minikube status                 # the OTHER profile - probably "Stopped"
minikube status -p keeperhub    # this stack
minikube profile list           # ACTIVE PROFILE and ACTIVE KUBECONTEXT differ
```

`minikube profile list` shows the split directly: the `-p` flag drives every
`minikube` subcommand, while `kubectl` follows its own current context. Pass
`-p keeperhub` to `minikube` and `--context keeperhub` to `kubectl`, which is
what every target in the Makefile does. To stop typing `-p`, make it the default
with `minikube profile keeperhub`; switch back with `minikube profile minikube`.

## Why calico

`setup-local-kubernetes` creates the cluster with `--cni=calico`. minikube's
default CNI accepts a `NetworkPolicy` object and enforces nothing, so an egress
restriction would appear to work while blocking nothing at all. Since the point
of running per-execution Jobs locally is to be able to test the isolation model,
a CNI that silently no-ops would make the whole exercise misleading.

If you have an older cluster without calico, setup will tell you and stop.
`--recreate` deletes and rebuilds it, which also destroys the local database.

## Migrations

The local stack applies file-based migrations with `pnpm db:migrate`, in the
app's `db-migration` initContainer, from the migrator image. That is exactly what
staging and production do, which is the point: a local environment that
bootstraps its schema differently from production is not evidence of anything.

It used to run `pnpm db:push`, which produces a schema that never has to match
what a migration would have produced.

If your local database predates this change it will have the tables but an empty
drizzle journal, and `db:migrate` will fail with "relation already exists".
Setup detects this and stops with two options:

```bash
./deploy/local/setup-local.sh --reset-db   # start clean (recommended)
make local-db-recover                      # keep the data, backfill the journal
```

## The queue

ElasticMQ, not LocalStack. It speaks the SQS API, so no application code
changes: the same `@aws-sdk/client-sqs` reaches it through `AWS_ENDPOINT_URL`.
It also needs no auth token, which takes a paid third-party dependency off the
critical path of setting up a development environment.

Queues are declared statically in the ConfigMap in
`manifests/elasticmq.yaml` rather than created by an API call after startup, so
readiness means the queues already exist and there is no bootstrap race.

One thing to know when debugging. The queue URL is part of what each message's
HMAC signature covers, and the executor verifies against its own configured URL,
so a producer and the consumer disagreeing by even one byte rejects every
message as `bad_signature`. That is why the URL is defined once, in
`lib/common.sh`, and templated into every component from there. If you see
rejections, compare `make queue-status` against `SQS_QUEUE_URL` in that file.

Locally `SQS_HMAC_MODE` is `enforce`, matching production, and the dead-letter
queue is live so a rejected message is visible rather than simply gone.

## Layout

| Path | What it is |
| --- | --- |
| `lib/common.sh` | every value shared between the two scripts |
| `setup-local.sh` | cluster, TLS, PostgreSQL, queue |
| `deploy.sh` | image build and load, secrets, chart install |
| `manifests/` | namespace and ElasticMQ |
| `docker-bake.local.hcl` | bake overlay giving the images local tags |
| `../keeperhub-stack/self-hosted/values.yaml` | the chart values, a peer of `staging/` and `prod/` |

The values file lives beside the staging and production ones on purpose. Diff it
against `staging/values.yaml` when you change either; this environment is only
useful while it stays structurally the same as what really runs.

`setup-local.sh` owns what staging gets from Terraform and EKS. `deploy.sh` owns
what CI does on a real deploy.

## Common tasks

```bash
make status                                  # pods, services, ingress
make logs                                    # app logs
make restart                                 # restart the app
make deploy-to-local-kubernetes-skip-build   # redeploy without rebuilding images
make teardown                                # uninstall the release
minikube delete -p keeperhub                 # remove the cluster entirely
```

Iterating on values or manifests without rebuilding images:

```bash
IMAGE_TAG=$(git rev-parse --short HEAD) ./deploy/local/deploy.sh --skip-build
```

## Other local options

This directory is the full Kubernetes path. For UI and API work that does not
need the execution pipeline, `make dev-up` runs Docker Compose and is much
lighter. `hybrid/` runs the datastores in Compose and only the executor in
minikube.
