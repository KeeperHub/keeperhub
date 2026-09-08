# Installing KeeperHub on your own Kubernetes cluster

Start: a Kubernetes cluster and nothing else. Finish: a working install you have
signed into.

About an hour, most of it waiting for one image build.

This guide names specific tools only as examples, in the places where you may not
already have something. Where you do, use yours. What the install actually needs
is listed as capabilities in step 2, and nothing here assumes a particular cloud,
registry, ingress controller or certificate authority.

---

## 1. Before you start

**Tools.** Each should print a version:

```bash
kubectl version --client   # already pointed at your cluster
helm version               # v3
docker buildx version
git --version
envsubst --version         # from gettext
```

**A container registry** your cluster can pull from, and which you can push to.
Any OCI registry works: a cloud provider's, a self-hosted one, or a public one.

Log in to it, then confirm *which identity* you are logged in as. This catches a
trap that otherwise only shows up as `denied` after a long build:

```bash
docker login <your-registry>

# Confirm the identity actually cached for that registry
python3 -c "import json,os,base64; d=json.load(open(os.path.expanduser('~/.docker/config.json'))); \
print({k: base64.b64decode(v['auth']).decode().split(':')[0] for k,v in d.get('auths',{}).items() if v.get('auth')})"
```

If the registry is private, your cluster also needs a pull secret. Create one and
name it per component with `<component>.imagePullSecrets`.

**A domain you control**, for example `app.yourcompany.com`. Not optional: the
app is served on it, and any mail or identity provider you use will verify you
own it.

**A mail relay.** Signup sends a six-digit code, so without one nobody can create
an account. The app speaks SendGrid's v3 `mail/send` request shape; any relay
that accepts that shape works, and `SENDGRID_API_URL` points at it. That is a
protocol requirement, not a vendor one.

Optional, each switchable off and each independent of the others: a wallet
signing service for on-chain writes, a chain RPC provider, a captcha provider,
and an OAuth identity provider for social sign-in. `.env.example` says what each
one unlocks.

---

## 2. Prepare the cluster

Four capabilities. If your cluster already provides one, skip it — the commands
below are one way to get each, not the required way.

**a) A default StorageClass.** Most clusters have one.

```bash
kubectl get storageclass
```

**b) An ingress controller.** Any will do; you name its class in `.env`.

```bash
kubectl get ingressclass          # do you already have one?

# If not, one option:
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

**On a cluster with no cloud load balancer, the caller's address needs two
settings.** K3s and clusters like it answer a `LoadBalancer` Service with a
small proxy on each node. A request can arrive at a node that does not hold the
ingress controller pod. That node forwards the request, and the source address
becomes an address from the cluster's own pod range. Per-IP rate limits and any
address rule you keep then work on that address instead of the caller's. Nothing
else looks wrong, because the install works, pages load and workflows run. Set
the controller Service to `externalTrafficPolicy: Local`, which stops the
rewrite. Run the controller as a DaemonSet, so that every node holds a pod. One
setting without the other is not enough. `Local` alone keeps the address only on
the node that holds the controller, and a DaemonSet alone does not stop the
rewrite.

```bash
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --reuse-values \
  --set controller.kind=DaemonSet \
  --set controller.service.externalTrafficPolicy=Local
```

**c) TLS — pick one.**

*Let the chart request certificates.* It emits a cert-manager `Certificate`
referencing a `ClusterIssuer`, so this route needs cert-manager and an issuer.
Set `TLS_ISSUER` in `.env` to the issuer's name.

```bash
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true
```

Then create a `ClusterIssuer` for whichever CA you use. An ACME issuer suits a
publicly resolvable domain; a private CA or a self-signed issuer suits an
internal one.

*Or terminate TLS somewhere else*, at a load balancer or service mesh. Then skip
cert-manager entirely, leave `TLS_ISSUER` empty, and pass
`--set app.service.tls.enabled=false` when you install. Nothing else changes.

**d) PostgreSQL. Required — there is no third option.**

The product stores everything in PostgreSQL. You either give the chart one, or
you let it run one. Decide now, because the choice changes what you install here
and what you put in `.env`.

*Option 1 — bring your own* (`DB_MODE=byo`). Use a database you already run: a
managed one from your provider, or your own server. Nothing to install in the
cluster. Put the connection string in a Secret before you install, because the
chart reads it and the install refuses to start without it:

```bash
kubectl create namespace keeperhub

kubectl -n keeperhub create secret generic keeperhub-db \
  --from-literal=DATABASE_URL='postgresql://user:password@host:5432/keeperhub?sslmode=verify-full'
```

Then in `.env` set `DB_MODE="byo"`. The Secret's name and key are configurable
there too, as `DB_SECRET_NAME` and `DB_SECRET_KEY`, if `keeperhub-db` and
`DATABASE_URL` do not suit you.

Four things decide whether a bring-your-own database works. Get them right
before you install; each one fails in a way that does not name itself.

**PostgreSQL 13 or newer, and the role you connect as must own the database.**
The install creates schemas (`workflow`, `drizzle`, `workflow_drizzle`,
`graphile_worker`) and, on PostgreSQL 15 and later, the `public` schema is not
writable by a role that does not own it. A least-privilege role fails at the
first `CREATE TABLE`. Create the database *as* the role in the connection
string, or grant it ownership:

```sql
ALTER SCHEMA public OWNER TO <your_role>;
GRANT ALL ON SCHEMA public TO <your_role>;
```

No superuser is needed, and no extensions are installed, so an ordinary managed
admin account is enough.

**Put an explicit `sslmode` in the URL.** Without one the driver defaults to a
plaintext connection. A managed database that requires TLS then refuses it, and
the symptom is the install sitting in `wait-for-db` for five minutes before
rolling the whole release back — an error about a timeout, not about TLS. Use
`sslmode=verify-full` unless you have a reason not to; the application forces it
for any host outside the cluster anyway. Verification uses the system trust
store, so a database whose certificate chains to a public root needs nothing
extra. A private CA needs it mounted and named in `NODE_EXTRA_CA_CERTS`.

**Size for connections, not for data.** This is small on disk and wide on
connections, because each per-execution runner Job opens its own:

| | connections |
| --- | --- |
| At rest | about 45 |
| With four concurrent executions | about 85 |
| Recommended `max_connections` | 200 or more |

The chart-managed database is configured for 200. Entry-level managed tiers are
often capped near 50 or 100, which survives an idle install and fails the first
time several workflows run at once. Lower `MAX_CONCURRENT_JOBS` if you must use
a small tier.

**Do not put a transaction-mode connection pooler in front of it.** The workflow
engine relies on `LISTEN`/`NOTIFY`, which transaction pooling breaks. Connect
directly, or use session-mode pooling.

*Option 2 — let the chart run one* (`DB_MODE=bundled`). It creates and manages a
PostgreSQL cluster for you, which brings failover and backups with it. This is
the route that needs the CloudNativePG operator installed cluster-wide:

```bash
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml

# The apply returns before the operator is running. Wait for it.
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager
```

That wait matters. The operator serves an admission webhook, and installing
before it answers fails partway through the release with
`failed calling webhook "mcluster.cnpg.io" ... connection refused`. The
installer waits for it too, so this is belt and braces rather than strictly
required.

Nothing else to do: the chart generates the credentials and writes the Secret
itself. Size it with `PG_INSTANCES` and `PG_STORAGE_SIZE` in `.env`.

**e) A queue.** Same shape, and also required. `QUEUE_MODE=bundled` runs one for
you with nothing to install first. `QUEUE_MODE=byo` points at any SQS-compatible
endpoint you operate, named by `SQS_QUEUE_URL` and `SQS_DLQ_URL` in `.env`.

---

## 3. Fill in your settings

This is the only file you edit. Everything after this reads from it.

```bash
git clone https://github.com/KeeperHub/keeperhub.git
cd keeperhub/deploy/keeperhub-stack/self-hosted

cp .env.example .env
```

Open `.env` and work through it. It is in three parts:

- **REQUIRED** - the install will not work without these.
- **REQUIRED AT BUILD TIME** - compiled into the image. Any may be left empty,
  and empty switches that feature off cleanly. Getting one *wrong* means
  rebuilding, which is why they are decided before you build.
- **OPTIONAL** - each unlocks one area. Leave empty to leave it off.

Two notes while you are in there. Keep the quotes around values, because the
build reads this file with the shell. And if you are going to set
`CHAIN_RPC_CONFIG` at all, set it now: it is read when the database is first
seeded, so a value added later leaves the Block and Event triggers connected to
nothing.

`.env` is gitignored. Do not commit it.

---

## 4. Build the images

From the repository root:

```bash
cd ../../..                                  # back to the repo root
set -a; . deploy/keeperhub-stack/self-hosted/.env; set +a
export IMAGE_TAG=v1

docker buildx bake \
  -f docker-bake.hcl \
  -f deploy/keeperhub-stack/self-hosted/docker-bake.hcl \
  --set "*.cache-from=" --set "*.cache-to=" \
  --push keeperhub
```

Copy that command as it stands. Both `-f` files and both `--set` flags are load
bearing:

- Naming the files stops bake also discovering `docker-compose.yml`, which
  expects a different `.env` and fails a fresh clone with
  `env file .env not found`.
- The `--set` flags drop a build cache the file exports to a registry you do not
  have. Without them Docker's default builder stops with
  `Cache export is not supported for the docker driver`.

That produces eight images in the repository you named, each under its own tag
prefix: `app-`, `migrator-`, `workflow-runner-`, `executor-`, `schedule-`,
`block-`, `collector-`, `sandbox-`.

---

## 5. Install

```bash
cd deploy/keeperhub-stack/self-hosted
ENV_FILE=.env IMAGE_TAG=v1 ./install.sh
```

It checks the prerequisites first and stops with a message naming anything
missing. Watch it come up:

```bash
kubectl -n keeperhub get pods -w
```

---

## 6. Point your domain at it, and sign in

```bash
kubectl -n keeperhub get ingress
```

Point your `APP_HOST` at that address however your DNS works, then:

```bash
curl https://app.yourcompany.com/api/health
# {"status":"ok","timestamp":"..."}
```

Open the site, choose **Create an account**, and enter the six-digit code from
your inbox. You will set up two-factor authentication, then name your
organisation. That is the whole thing.

---

## If something looks wrong

These fail quietly, leaving every pod green.

| Symptom | Cause |
| --- | --- |
| `denied` when pushing images | logged in to that registry as a different identity than you expect. Check the identity, not just that a login exists |
| Signup form renders, then "Missing CAPTCHA response" | the captcha site key was wrong at build time. Rebuild, or set `TURNSTILE_DISABLED=true` |
| The six-digit code never arrives | no working mail relay, or a From address the relay has not verified |
| The UI loads and reads, but every save returns 403 | `APP_HOST` does not match the hostname you are using |
| Block or Event triggers never fire | `CHAIN_RPC_CONFIG` was set after installing, or a chain key is misspelled. The keys are exact: Ethereum's testnet is `eth-sepolia`, Base's is `base-testnet` |
| A sign-in button appears but the flow fails | a client id is set and its secret is not, or the reverse |
| Install hangs in `wait-for-db`, then the release rolls back | with `DB_MODE=byo`, usually a missing `sslmode` in the URL against a database that requires TLS. Also check the firewall actually allows the cluster |
| Install reaches the migration and fails on `CREATE TABLE` or `CREATE SCHEMA` | the role in the URL does not own the database. See the ownership note in step 2d |
| Workflows fail only when several run at once | the database ran out of connections. Raise `max_connections` or lower `MAX_CONCURRENT_JOBS` |
| Scheduled workflows stop firing for no obvious reason | a transaction-mode pooler between the app and the database is swallowing `LISTEN`/`NOTIFY` |
| Every execution stalls after you turned on `EGRESS_POLICY`, and every pod is green | the policy is blocking the API server, so the executor cannot create a Job. Re-run with `EGRESS_POLICY_VERIFY=true`, which names this case |

---

## Optional: lock down outbound traffic

Once it works, deny all egress except what the product needs:

```bash
EGRESS_POLICY=true EGRESS_POLICY_VERIFY=true ENV_FILE=.env IMAGE_TAG=v1 ./install.sh
```

This blocks your private network, your nodes and any cloud metadata service,
while allowing DNS, the API server and the public internet. The API server
address is read from your cluster, so the rule is right on kubeadm, on minikube
and on k3s, which put it in three different places.

It only takes effect if your CNI enforces NetworkPolicy, and several do not.
`EGRESS_POLICY_VERIFY=true` measures that rather than guessing at it: it makes
two TCP connects from a pod that is already running, one to the API server and
one to an address the policy denies, and reports which of three things happened.

| It says | What it means |
| --- | --- |
| the policy is enforced and the API server is still reachable | done |
| NOT enforced | the objects exist and nothing is restricted. Your CNI ignores NetworkPolicy |
| BROKEN | the policy is enforced and it blocks the API server. Executions will stall while every pod stays green. Set `APISERVER_CIDR` and `APISERVER_PORT`, or turn the policy off until you have |

The check creates nothing, deletes nothing and never fails the install. Leave it
off once a cluster has passed it.

---

## Where to look next

- `README.md` beside this file - every setting explained
- `DEPENDENCIES.md` - every host the product contacts, and how to switch each
  one off
