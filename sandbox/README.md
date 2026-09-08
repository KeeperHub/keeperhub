# @keeperhub/sandbox

Standalone HTTP service that evaluates user JavaScript for the KeeperHub Code workflow node. Uses `node:vm` + `child_process` with a `\x01RESULT\x02` sentinel framing the response.

## Endpoints

- `GET /healthz` -> `200 ok`
- `POST /run`
  - Request body: JSON `{ code, timeout }` (`Content-Type: application/json`).
  - Response: `\x01RESULT\x02` + tagged-JSON(ChildOutcome) + `\n` (`Content-Type: application/json`). The tagged-JSON codec (`encodeSandboxResult` / `decodeSandboxResult` in `lib/sandbox/child-source.ts`) preserves BigInt, Map, Set, Date, RegExp, typed arrays, and `undefined`. Neither direction uses `v8.serialize`/`v8.deserialize`: the response is decoded with a safe `JSON.parse` + prototype-pollution-safe rebuild, so untrusted child bytes can never reach a deserialization gadget.

## Wire protocol is a hard cutover (deploy ordering)

The JSON request + tagged-JSON response above replaced a `base64(v8.serialize(...))` wire in both directions, with **no dual-accept shim**. The sandbox service and the main app deploy as separate artifacts, so a version mismatch in either direction during a wire change makes `POST /run` return `400` and remote Code-node runs fail for that window (clean failure, no crash or corruption). When changing the wire format: deploy the sandbox service first, then the app, as close together as possible. The app's `SANDBOX_BACKEND=local` is an escape hatch that bypasses this HTTP boundary during a cutover.

## Env

- `SANDBOX_PORT` (default `8787`)

## Runtime

- `gcr.io/distroless/nodejs24-debian12`, pinned by digest. No shell, no
  busybox, no package manager, no compiler - the only spawnable
  executable in the image is `/nodejs/bin/node`. A successful node:vm
  escape lands in a process that has nothing to run.
- Zero runtime npm deps (Node built-ins only).
- No init / tini. Distroless runs the node binary as PID 1; child
  processes are reaped by node itself (`child_process.spawn` returns
  immediately on exit because the parent listens on the `exit` event).
  Kubernetes terminationGracePeriodSeconds handles the pod-stop path.

## Kubernetes requirement (downstream deploy)

The pod MUST be deployed with:

- `automountServiceAccountToken: false` and a dedicated ServiceAccount
  with no RoleBindings and no `eks.amazonaws.com/role-arn` IRSA
  annotation - this image does not include credentials.
- `readOnlyRootFilesystem: true` with an `emptyDir { medium: Memory }`
  at `/tmp` so the only writable surface is non-persistent tmpfs.
- `runAsNonRoot: true`, `runAsUser: 1001`, `seccompProfile: RuntimeDefault`,
  `capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`.
- A NetworkPolicy that denies all egress except DNS to kube-dns and
  TCP 443 to the public internet (private CIDRs and IMDS excluded), and
  restricts ingress to other pods in the same namespace.

The reference manifests are in `deploy/keeperhub-sandbox/` in the
parent repo; the minikube validation manifest at
`deploy/keeperhub-sandbox/local/validation.yaml` is the stripped
equivalent for smoke-testing without the chart.
